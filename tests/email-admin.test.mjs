import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { prepareAcdTestPool, seedAgent, seedQueue } from './helpers/acd-test-db.mjs';
import { emailAdminOverview, emailAdminAction, emailAdminResource } from '../lib/email/admin.mjs';
import { emailConfig } from '../lib/email/provider.mjs';
import { configuredEmailDomains, normalizeEmailDomain, rememberEmailDomain, ensureEmailWebhook } from '../lib/email/domains.mjs';

const db = await prepareAcdTestPool('acd_core_test_email_admin');
await db.query("DROP TABLE IF EXISTS app_settings; CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb)");
after(() => db.end());
beforeEach(async () => {
  for (const key of ['CC_MAIL_DOMAIN','TELNYX_WEBHOOK_BASE_URL','NEXT_PUBLIC_BASE_URL','NEXTAUTH_URL','TELNYX_WEBHOOK_SECRET']) delete process.env[key];
  process.env.APP_BASE_URL='https://contact.example.com';
  process.env.TELNYX_WEBHOOK_PUBLIC_KEY='test-public-key';
  await db.query("DELETE FROM cc_email_audit; DELETE FROM cc_email_mailboxes; DELETE FROM app_settings; INSERT INTO app_settings VALUES('default','{\"chat_copilot\":{\"model\":\"test/model\",\"bucketIds\":[]},\"preserved\":true}')");
});

function provider(domains=[]) {
  const calls=[], hooks=[];
  const request=async (path, options={}) => {
    calls.push({path,...options});
    if(path.startsWith('/email_domains?'))return {data:domains,meta:{total_pages:1}};
    if(path==='/email_domains'&&options.method==='POST'){
      const data={id:`domain-${domains.length}`,status:'pending',...options.body};domains.push(data);return {data};
    }
    const domain=domains.find(row=>path.startsWith(`/email_domains/${row.id}`));
    if(!domain)throw Error(`Unexpected provider call: ${path}`);
    if(path.endsWith('/webhooks')||path.includes('/webhooks?')){
      if(options.method==='POST'){const data={id:`hook-${hooks.length}`,...options.body};hooks.push(data);return {data};}
      return {data:hooks};
    }
    if(path.includes('/webhooks/')){const hook=hooks.find(h=>path.endsWith(`/${h.id}`));Object.assign(hook,options.body);return {data:hook};}
    if(options.method==='PATCH'){Object.assign(domain,options.body);if(options.body.inbound_enabled!=null)domain.inbound={enabled:options.body.inbound_enabled};}
    return {data:domain};
  };
  return {request,calls,domains,hooks};
}

test('email Copilot saves and reloads its own token budget without changing chat settings',async()=>{
  const settings={model:'email-test',bucketIds:[],maxTokens:16000};
  await emailAdminAction(db,{action:'save_copilot',settings},'admin');
  const saved=(await db.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0].cc_settings;
  assert.deepEqual(saved.email_copilot,settings);
  assert.equal(saved.chat_copilot.model,'test/model');
  assert.equal((await emailAdminOverview(db)).copilot.maxTokens,16000);
});

test('fresh installation has no implicit domain and does not expose account inventory',async()=>{
  assert.equal(emailConfig().domain,'');
  const overview=await emailAdminOverview(db);
  assert.equal(overview.domain,null);assert.deepEqual(overview.domains,[]);
  for(const resource of ['domains','inboxes'])assert.deepEqual(await emailAdminResource(db,new URLSearchParams({resource}),{request:()=>assert.fail('must not fetch unrelated inventory')}),{data:[]});
});

test('domain input accepts normalized DNS names and rejects URLs, email addresses and invalid hostnames',()=>{
  assert.equal(normalizeEmailDomain(' Mail.Example.COM. '),'mail.example.com');
  assert.equal(normalizeEmailDomain('münchen.example'),'xn--mnchen-3ya.example');
  for(const value of ['',null,'https://example.com','me@example.com','example.com/path','example.com:443','localhost','127.0.0.1','*.example.com','bad..example','-bad.example',`${'a'.repeat(64)}.example`])assert.throws(()=>normalizeEmailDomain(value),e=>e.status===400);
});

test('registering an explicit domain persists its scope and automatically subscribes the application URL',async()=>{
  const p=provider();
  const result=await emailAdminAction(db,{action:'create_domain',domain:' Mail.Example.com ',url:'https://untrusted.example/hook'},'admin',p);
  assert.equal(result.warning,undefined);
  assert.deepEqual(await configuredEmailDomains(db),['mail.example.com']);
  assert.deepEqual(p.calls.find(c=>c.path==='/email_domains').body,{domain:'mail.example.com',inbound_enabled:true});
  assert.equal(p.hooks[0].url,'https://contact.example.com/api/webhooks/telnyx/email');
  assert(p.hooks[0].events.includes('email.received'));
  await emailAdminAction(db,{action:'verify_domain',domainId:p.domains[0].id},'admin',p);
  assert.equal(p.hooks.length,1);
  assert.equal((await db.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0].cc_settings.preserved,true);
});

test('an explicitly named existing domain is reused while unrelated account domains stay out of scope',async()=>{
  const p=provider([{id:'existing',domain:'mail.example.com',inbound:{enabled:false}},{id:'other',domain:'other.example',inbound:{enabled:true}}]);
  await emailAdminAction(db,{action:'create_domain',domain:'mail.example.com'},'admin',p);
  assert.equal(p.calls.filter(c=>c.path==='/email_domains'&&c.method==='POST').length,0);
  assert.equal(p.domains[0].inbound.enabled,true);
  const listed=await emailAdminResource(db,new URLSearchParams({resource:'domains'}),p);
  assert.deepEqual(listed.data.map(d=>d.id),['existing']);
  await assert.rejects(emailAdminAction(db,{action:'verify_domain',domainId:'other'},'admin',p),e=>e.status===403);
  assert(!p.calls.some(c=>c.path.includes('/other/')&&c.method));
});

test('concurrent domain saves preserve every registration and unrelated Copilot settings',async()=>{
  await Promise.all(['one.example','two.example','one.example'].map(domain=>rememberEmailDomain(db,domain)));
  assert.deepEqual((await configuredEmailDomains(db)).sort(),['one.example','two.example']);
  const settings=(await db.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0].cc_settings;
  assert.equal(settings.chat_copilot.model,'test/model');
});

test('existing mailbox domains and an explicitly configured legacy domain remain available',async()=>{
  process.env.CC_MAIL_DOMAIN='Configured.Example';
  await seedAgent(db,'admin-domain-agent');await seedQueue(db,'admin-domain-queue',['admin-domain-agent']);
  await db.query("INSERT INTO cc_email_mailboxes(id,provider_inbox_id,domain_id,address,name,queue_id) VALUES('00000000-0000-4000-8000-000000000001','inbox','legacy','support@legacy.example','Legacy','admin-domain-queue')");
  assert.deepEqual((await configuredEmailDomains(db)).sort(),['configured.example','legacy.example']);
  const response=await emailAdminResource(db,new URLSearchParams({resource:'inboxes'}),{request:async()=>({data:[{email:'support@legacy.example'},{email:'outside@other.example'}]})});
  assert.deepEqual(response.data,[{email:'support@legacy.example'}]);
});

test('missing server webhook configuration preserves the registered domain and can be retried by verification',async()=>{
  delete process.env.TELNYX_WEBHOOK_PUBLIC_KEY;
  const p=provider();
  const result=await emailAdminAction(db,{action:'create_domain',domain:'mail.example.com'},'admin',p);
  assert.match(result.warning,/Domain added.*public key/);
  assert.deepEqual(await configuredEmailDomains(db),['mail.example.com']);assert.equal(p.hooks.length,0);
  process.env.TELNYX_WEBHOOK_PUBLIC_KEY='test-public-key';
  const retry=await emailAdminAction(db,{action:'verify_domain',domainId:p.domains[0].id},'admin',p);
  assert.equal(retry.warning,undefined);assert.equal(p.hooks.length,1);
});

test('mailbox mapping uses the provider inbox domain instead of the currently selected browser domain',async()=>{
  await rememberEmailDomain(db,'second.example');
  await seedAgent(db,'mapping-agent');await seedQueue(db,'mapping-queue',['mapping-agent']);
  const input={action:'save_mailbox',name:'Support',inboxId:'second-inbox',domainId:'wrong-browser-domain',queueId:'mapping-queue'};
  const result=await emailAdminAction(db,input,'admin',{request:async()=>({data:{email:'support@second.example',domain_id:'second-domain'}})});
  assert.equal(result.result.domain_id,'second-domain');
  await assert.rejects(emailAdminAction(db,input,'admin',{request:async()=>({data:{email:'support@second.example'}})}),e=>e.status===502);
});

test('automatic subscription preserves other destinations and adds missing events to its own hook',async()=>{
  const p=provider([{id:'domain',domain:'mail.example.com'}]);
  p.hooks.push({id:'foreign',url:'https://other.example/hook',events:['email.sent']},{id:'own',url:'https://contact.example.com/api/webhooks/telnyx/email',events:['email.clicked']});
  await ensureEmailWebhook('domain',p.request);
  assert.deepEqual(p.hooks[0],{id:'foreign',url:'https://other.example/hook',events:['email.sent']});
  assert(p.hooks[1].events.includes('email.received'));assert(p.hooks[1].events.includes('email.clicked'));
  await ensureEmailWebhook('domain',p.request);
  assert.equal(p.calls.filter(c=>c.method==='PATCH').length,1);
});

test('domain verification re-enables the nested inbound flag',async()=>{
  await rememberEmailDomain(db,'mail.example.com');
  const p=provider([{id:'domain',domain:'mail.example.com',inbound:{enabled:false}}]);
  await emailAdminAction(db,{action:'verify_domain',domainId:'domain'},'admin',p);
  assert.equal(p.domains[0].inbound.enabled,true);assert(p.calls.some(c=>c.method==='PATCH'&&c.body.inbound_enabled===true));
});

test('webhook discovery checks subsequent pages before updating an existing destination',async()=>{
  const calls=[],url='https://contact.example.com/api/webhooks/telnyx/email';
  await ensureEmailWebhook('domain',async(path,options={})=>{
    calls.push({path,...options});if(options.method)return {data:{}};
    const page=new URL(path,'https://provider.test').searchParams;
    assert.equal(page.get('page[size]'),'100');
    return {data:page.get('page[number]')==='1'?[{id:'other',url:'https://other.example',events:[]}]:[{id:'own',url,events:['email.clicked']}],meta:{total_pages:2}};
  });
  assert.equal(calls.length,3);assert.equal(calls[2].method,'PATCH');assert.equal(calls[2].path,'/email_domains/domain/webhooks/own');assert(calls[2].body.events.includes('email.clicked'));
});

test('saving one sender list adds and removes entries without replacing the independent list',async()=>{
  await rememberEmailDomain(db,'mail.example.com');
  const lists={allowlist:['trusted@example.com'],blocklist:['old@example.com']},calls=[];
  const request=async(path,options={})=>{
    calls.push({path,...options});if(path==='/email_inboxes/inbox')return {data:{email:'support@mail.example.com'}};
    assert.equal(path,'/email_inboxes/inbox/filters');assert.notEqual(options.method,'PUT');
    if(options.method==='DELETE'){lists.blocklist=lists.blocklist.filter(v=>!options.body.entries.includes(v));lists.allowlist.push('concurrent@example.com');}
    if(options.method==='POST')lists.blocklist.push(...options.body.entries);
    return {data:structuredClone(lists)};
  };
  const input={action:'save_filters',inboxId:'inbox',payload:{type:'blocklist',entries:['NEW@example.com','@Spam.Example']}};
  await emailAdminAction(db,input,'admin',{request});assert.deepEqual(lists.blocklist,['new@example.com','@spam.example']);assert.deepEqual(lists.allowlist,['trusted@example.com','concurrent@example.com']);
  const mutations=calls.filter(c=>c.method).length;await emailAdminAction(db,input,'admin',{request});assert.equal(calls.filter(c=>c.method).length,mutations);
  await assert.rejects(emailAdminAction(db,{...input,payload:{type:'unknown',entries:[]}},'admin',{request}),e=>e.status===400);
});

test('browser cannot create, change, delete or read webhook configuration',async()=>{
  const p={request:()=>assert.fail('must not call provider')};
  for(const action of ['create_webhook','update_webhook','delete_webhook'])await assert.rejects(emailAdminAction(db,{action,domainId:'domain',url:'https://other.example'},'admin',p),e=>e.status===400);
  await assert.rejects(emailAdminResource(db,new URLSearchParams({resource:'webhooks',domainId:'domain'}),p),e=>e.status===400);
});

test('unusable HTTP webhook base does not register a destination',async()=>{
  process.env.APP_BASE_URL='http://localhost:3000';
  await assert.rejects(ensureEmailWebhook('domain',()=>assert.fail('must not call provider')),e=>e.status===503);
});

test('audit resolves current profile names with username and missing-user fallbacks',async()=>{
  await seedAgent(db,'audit-named');await seedAgent(db,'audit-username');
  await db.query("UPDATE users SET first_name='Alex',last_name='Taylor' WHERE id='audit-named'");
  await db.query("UPDATE users SET first_name=' ',last_name=NULL,username='admin@example.com' WHERE id='audit-username'");
  for(const actor of ['audit-named','audit-username','removed-admin'])await db.query("INSERT INTO cc_email_audit(actor_id,action) VALUES($1,'sync')",[actor]);
  const audit=(await emailAdminOverview(db)).audit;
  assert.deepEqual(audit.map(row=>row.actor_name),['Unknown administrator','admin@example.com','Alex Taylor']);
  assert.equal(audit.at(-1).actor_id,'audit-named');
  await db.query("UPDATE users SET first_name='Alexandra' WHERE id='audit-named'");
  assert.equal((await emailAdminOverview(db)).audit.at(-1).actor_name,'Alexandra Taylor');
});

test('inbox inventory follows every page, preserves provider metadata and enforces domain scope',async()=>{
  await rememberEmailDomain(db,'mail.example');
  const inbox={id:'support',address:'support@mail.example',domain:'mail.example',domain_id:'domain',status:'active',created_at:'2026-09-13T09:24:27Z',updated_at:'2026-09-13T09:24:27Z',settings:{},record_type:'email_inbox'};
  const calls=[];
  const result=await emailAdminResource(db,new URLSearchParams({resource:'inboxes'}),{request:async path=>{
    calls.push(path);
    return path.includes('page_cursor=next')?{data:[inbox]}:{data:[{id:'other',address:'other@outside.example'}],meta:{page_cursor:'next'}};
  }});
  assert.equal(calls.length,2);assert.deepEqual(result.data,[inbox]);
});

test('a repeating inbox cursor fails explicitly instead of returning incomplete inventory',async()=>{
  await rememberEmailDomain(db,'mail.example');
  await assert.rejects(emailAdminResource(db,new URLSearchParams({resource:'inboxes'}),{request:async()=>({data:[],meta:{page_cursor:'same'}})}),e=>e.status===502);
});
