import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { prepareAcdTestPool, seedAgent, seedQueue } from './helpers/acd-test-db.mjs';
import { DEFAULT_EMAIL_PREVIEW_SETTINGS, parseEmailPreviewSettings, loadEmailPreviewSettings } from '../lib/email/preview-settings.mjs';
import { emailAdminAction, emailAdminOverview } from '../lib/email/admin.mjs';
import { applyEmailInboxEvent, routePendingEmail } from '../lib/email/ingest.mjs';
import { heartbeatAgentSession } from '../lib/acd/sessions.mjs';
import { routeOne } from '../lib/acd/router.mjs';
import { readEmailDetail } from '../lib/email/store.mjs';
import { readConversationSnapshot } from '../lib/acd/conversation-preview.mjs';
import { clearSagaDeadlineWakeups } from '../lib/acd/saga-engine.mjs';

const db=await prepareAcdTestPool('acd_core_test_email_preview');
await db.query(`DROP TABLE IF EXISTS app_settings,cc_wrapup_codes;
  CREATE TABLE app_settings(id text PRIMARY KEY,cc_settings jsonb);
  CREATE TABLE cc_wrapup_codes(id text PRIMARY KEY,name text);`);
after(async()=>{clearSagaDeadlineWakeups();await db.end();});
beforeEach(async()=>{
  await db.query(`DELETE FROM app_settings; DELETE FROM cc_email_audit;
    INSERT INTO app_settings VALUES('default','{"chat_copilot":{"model":"test","bucketIds":[]},"email_domains":["mail.example"],"preserved":true}');`);
});

test('an existing or fresh installation starts with plain text, embedded images and no external image requests',async()=>{
  assert.deepEqual(await loadEmailPreviewSettings(db),DEFAULT_EMAIL_PREVIEW_SETTINGS);
  await db.query('DELETE FROM app_settings');
  assert.deepEqual(await loadEmailPreviewSettings(db),DEFAULT_EMAIL_PREVIEW_SETTINGS);
  const settings={format:'html',loadRemoteImages:false,showInlineImages:true};
  await emailAdminAction(db,{action:'save_preview',settings},'admin');
  assert.deepEqual(await loadEmailPreviewSettings(db),settings);
});

test('global preview saves preserve integration settings and record the administrator',async()=>{
  const settings={format:'html',loadRemoteImages:true,showInlineImages:false};
  const result=await emailAdminAction(db,{action:'save_preview',settings},'preview-admin',{
    request:()=>assert.fail('Display settings must not call Telnyx'),
  });
  assert.deepEqual(result.result,settings);
  const saved=(await db.query("SELECT cc_settings FROM app_settings WHERE id='default'")).rows[0].cc_settings;
  assert.equal(saved.preserved,true);
  assert.equal(saved.chat_copilot.model,'test');
  assert.deepEqual(saved.email_domains,['mail.example']);
  assert.deepEqual((await emailAdminOverview(db)).preview,settings);
  assert.deepEqual((await db.query('SELECT action,actor_id,resource_id FROM cc_email_audit')).rows,
    [{action:'save_preview',actor_id:'preview-admin',resource_id:'email_preview'}]);
});

test('invalid or extended display policies are rejected without changing the saved policy',async()=>{
  for(const value of [null,[],{}, {format:'pdf',loadRemoteImages:false,showInlineImages:true},
    {...DEFAULT_EMAIL_PREVIEW_SETTINGS,loadRemoteImages:'false'},
    {...DEFAULT_EMAIL_PREVIEW_SETTINGS,allowScripts:true}]) {
    assert.throws(()=>parseEmailPreviewSettings(value),{status:400});
    await assert.rejects(emailAdminAction(db,{action:'save_preview',settings:value},'admin'),{status:400});
  }
  assert.deepEqual(await loadEmailPreviewSettings(db),DEFAULT_EMAIL_PREVIEW_SETTINGS);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM cc_email_audit')).rows[0].count,0);
});

test('agent and supervisor snapshots use the same saved policy and refresh it without another message',async()=>{
  const agentId=randomUUID(),queueId=randomUUID(),mailboxId=randomUUID(),providerId=randomUUID();
  await seedAgent(db,agentId,{voiceReady:false});await seedQueue(db,queueId,[agentId]);
  await db.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'email',true,3,0.2)",[queueId]);
  await db.query("INSERT INTO cc_agent_channel_policies(agent_id,channel,enabled,max_concurrent,weight) VALUES($1,'email',true,3,0.2)",[agentId]);
  await heartbeatAgentSession(db,{agentId,sessionId:randomUUID(),emailReady:true});
  await db.query(`INSERT INTO cc_email_mailboxes(id,provider_inbox_id,domain_id,address,name,queue_id,routing_enabled,sending_enabled)
    VALUES($1,$2,'domain','support@mail.example','Support',$3,true,true)`,[mailboxId,randomUUID(),queueId]);
  await applyEmailInboxEvent(db,{event_type:'email.inbox_message',payload:{mailboxId,message:{id:providerId,
    from:'customer@example.com',to:['support@mail.example'],subject:'Preview policy',text_body:'Hello',html_body:'<p>Hello</p>'}}});
  await routePendingEmail(db);
  const work=(await db.query('SELECT * FROM acd_work_items WHERE queue_id=$1',[queueId])).rows[0];
  assert.equal((await routeOne(db,work.id)).routed,true);
  const identity={agentId,workItemId:work.id},scope={workItemId:work.id,user:{id:'supervisor',roles:['supervisor']}};
  const initial=await readConversationSnapshot(db,scope);
  assert.deepEqual(initial.snapshot.preview,DEFAULT_EMAIL_PREVIEW_SETTINGS);
  assert.deepEqual((await readEmailDetail(db,identity)).preview,initial.snapshot.preview);
  const settings={format:'html',loadRemoteImages:true,showInlineImages:false};
  await emailAdminAction(db,{action:'save_preview',settings},'admin');
  const next=await readConversationSnapshot(db,{...scope,after:initial.cursor,refreshSnapshot:true});
  assert.equal(next.cursor,initial.cursor);
  assert.deepEqual(next.snapshot.preview,settings);
  assert.deepEqual((await readEmailDetail(db,identity)).preview,settings);
  await assert.rejects(readEmailDetail(db,{...identity,agentId:'unassigned-agent'}),{status:403});
  await assert.rejects(readConversationSnapshot(db,{...scope,user:{id:'unassigned-agent',roles:['agent']}}),{status:404});
});
