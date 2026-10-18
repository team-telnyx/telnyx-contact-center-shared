import {test,after,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {prepareAcdTestPool,seedQueue} from './helpers/acd-test-db.mjs';
import {createWidget,updateWidgetDraft,publishWidget} from '../lib/widgets/store.js';
import {createWidgetBootstrapToken,widgetHandoffToken} from '../lib/widgets/session-tokens.js';
import {startWidgetSession,actAsWidgetCustomer,getWidgetSession,readWidgetConversation} from '../lib/widgets/sessions.js';
import {handoffWidgetChat} from '../lib/widgets/handoff.js';
import {normalizeAiImage,receiveAiImageMessage} from '../lib/widgets/ai-images.js';
import {encodeImageChatContent,listWidgetAssistants,widgetAiProvider} from '../lib/widgets/ai-provider.js';
process.env.WIDGET_SESSION_SIGNING_SECRET='controlled-images-test-signing-secret-more-than-32-characters';
process.env.TELNYX_API_KEY='test-only';
const pool=await prepareAcdTestPool('acd_core_test_widget_ai_images');
after(async()=>{mock.restoreAll();await pool.end();});
mock.method(globalThis,'fetch',async url=>Response.json(String(url).endsWith('/ai/openai/models')?{data:[{id:'moonshotai/Kimi-K2.6',is_vision_supported:true,recommended_for_assistants:true}]}:{id:'test-assistant',model:'moonshotai/Kimi-K2.6'}));
const provider={createConversation:async()=>randomUUID(),greeting:async()=>'',send:async()=> 'Blue image'};
const bytes=await sharp({create:{width:200,height:100,channels:3,background:'#1234dd'}}).png().toBuffer();
const image=await normalizeAiImage(new File([bytes],'test.png',{type:'image/png'}));
async function fixture(enabled=true){
 const q=randomUUID();await seedQueue(pool,q,[],{name:q});await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,5,0.2)",[q]);
 let w=await createWidget(pool,{name:randomUUID(),actor:'test'});let c=w.draft.config;c.allowedOrigins=['https://example.test'];c.channels.messaging.assistantId='test-assistant';c.channels.messaging.aiImages=enabled;c.channels.messaging.routing={queueId:q,queueName:q,queues:[{id:q,name:q}]};
 w=await updateWidgetDraft(pool,{id:w.id,config:c,expectedDraftId:w.draft.id,expectedEditVersion:w.draft.editVersion,actor:'test'});
 w=await publishWidget(pool,{id:w.id,expectedDraftId:w.draft.id,expectedEditVersion:w.draft.editVersion,actor:'test'},{provisionHandoff:async()=>({id:'test'})});
 const s=await startWidgetSession(pool,{publicId:w.publicId,bootstrapToken:createWidgetBootstrapToken({publicId:w.publicId,revisionId:w.published.id,origin:c.allowedOrigins[0]}),clientKey:randomUUID(),provider});return s;
}
test('image decoding strips metadata, rejects spoofed content and keeps wire data separate from text',async()=>{
 assert.equal((await sharp(image.bytes).metadata()).exif,undefined);
 const wire=JSON.parse(encodeImageChatContent('Read the picture',[image]));assert.equal(wire[0].text,'Read the picture');assert(wire[1].image_url.url.startsWith('data:image/webp;base64,'));
 await assert.rejects(normalizeAiImage(new File(['fake'],'fake.png',{type:'image/png'})));
 await assert.rejects(normalizeAiImage(new File([bytes],'fake.svg',{type:'image/svg+xml'})));
});
test('image-only messages survive reload and retries reject changed images without duplicate inference',async()=>{
 const s=await fixture();let calls=0;const params={token:s.sessionToken,action:'send',content:'',messageId:randomUUID(),images:[image],provider:{...provider,send:async(_s,text,_id,images)=>{calls++;assert.equal(text,'');assert.equal(images.length,1);return 'Blue image';}}};
 const first=await actAsWidgetCustomer(pool,params);assert.equal(first.messages[0].attachments.length,1);
 await actAsWidgetCustomer(pool,params);assert.equal(calls,1);
 await assert.rejects(actAsWidgetCustomer(pool,{...params,images:[{...image,content_hash:'different'}]}),/different images/);
 const state=await readWidgetConversation(pool,await getWidgetSession(pool,s.sessionToken));assert.equal(state.messages[0].attachments.length,1);assert.equal(state.messages[0].content,'');
});
test('handoff during inference preserves image bytes and suppresses the late AI answer',async()=>{
 const s=await fixture(),session=await getWidgetSession(pool,s.sessionToken);
 await actAsWidgetCustomer(pool,{token:s.sessionToken,action:'send',content:'Please help',messageId:randomUUID(),images:[image],provider:{...provider,send:async()=>{
  await handoffWidgetChat(pool,{sessionToken:widgetHandoffToken(session.id),body:{widget_session_id:session.id,telnyx_conversation_channel:'web_chat',summary:'Image troubleshooting',reason:'Customer requested agent'}});return 'Late response';
 }}});
 const state=await readWidgetConversation(pool,await getWidgetSession(pool,s.sessionToken));assert.equal(state.runtimeKind,'human');assert.equal(state.messages.filter(m=>m.role==='user')[0].attachments.length,1);assert(!state.messages.some(m=>m.content==='Late response'));
 const stored=(await pool.query('SELECT bytes FROM acd_text_attachments WHERE conversation_id=$1',[session.conversation_id])).rows;assert.equal(stored.length,1);assert.deepEqual(stored[0].bytes,image.bytes);
});
test('disabled AI images reject the request before consuming the upload body',async()=>{
 const s=await fixture(false);let consumed=false;
 const request={get body(){consumed=true;throw Error('Must not consume');}};
 await assert.rejects(receiveAiImageMessage(pool,{request,token:s.sessionToken}),e=>e.status===403);assert.equal(consumed,false);
});
test('new image uploads after handoff respect the human attachment policy before reading bytes',async()=>{
 const s=await fixture(),session=await getWidgetSession(pool,s.sessionToken);
 await pool.query("UPDATE cc_widget_revisions SET config=jsonb_set(config,'{features,attachmentsAfterHandoff}','false') WHERE id=$1",[session.revision_id]);
 await handoffWidgetChat(pool,{sessionToken:widgetHandoffToken(session.id),body:{widget_session_id:session.id,telnyx_conversation_channel:'web_chat',summary:'Human requested',reason:'Customer requested agent'}});
 let consumed=false;const request={get body(){consumed=true;throw Error('Must not consume');}};
 await assert.rejects(receiveAiImageMessage(pool,{request,token:s.sessionToken}),e=>e.status===403);assert.equal(consumed,false);
});
test('model catalog outages preserve assistant selection with unknown Vision capability',async t=>{
 let failure=503;
 t.mock.method(globalThis,'fetch',async url=>{
  if(String(url).includes('/ai/openai/models')){if(failure==='timeout')throw Error('Timed out');return Response.json({}, {status:failure});}
  const page=new URL(url).searchParams.get('page[number]');
  return Response.json({data:[{id:page==='1'?'b':'a',name:page==='1'?'B':'A',model:'moonshotai/Kimi-K2.6'}],meta:{total_pages:2}});
 });
 for(failure of [429,503,'timeout']){
  const assistants=await listWidgetAssistants();assert.deepEqual(assistants.map(a=>a.id),['a','b']);
  assert(assistants.every(a=>a.vision.status==='unknown'&&a.bufferedVision.status==='unknown'));
 }
});
test('image validation GET failures leave commands retryable and do not duplicate images or inference',async t=>{
 let failure=null,chatCalls=0;
 t.mock.method(globalThis,'fetch',async (url,options)=>{
  const catalog=String(url).endsWith('/ai/openai/models');
  if(options.method==='POST'){chatCalls++;return Response.json({content:'Blue image'});}
  if(failure&&(catalog===failure.catalog)){if(failure.timeout)throw Error('Timed out');return Response.json({}, {status:503});}
  return Response.json(catalog?{data:[{id:'moonshotai/Kimi-K2.6',is_vision_supported:true,recommended_for_assistants:true}]}:{id:'test-assistant',model:'moonshotai/Kimi-K2.6'});
 });
 for(const scenario of [{catalog:false},{catalog:true},{catalog:true,timeout:true}]){
  const s=await fixture(),session=await getWidgetSession(pool,s.sessionToken),before=chatCalls;
  const params={token:s.sessionToken,action:'send',content:'Describe',messageId:randomUUID(),images:[image],provider:widgetAiProvider};
  failure=scenario;await assert.rejects(actAsWidgetCustomer(pool,params),e=>e.ambiguous===false);assert.equal(chatCalls,before);
  assert.equal((await pool.query('SELECT state FROM cc_widget_ai_commands WHERE session_id=$1',[session.id])).rows[0].state,'rejected');
  failure=null;await actAsWidgetCustomer(pool,params);assert.equal(chatCalls,before+1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM cc_widget_ai_images WHERE session_id=$1',[session.id])).rows[0].n,1);
  await actAsWidgetCustomer(pool,{...params,messageId:randomUUID(),images:[],content:'Continue'});assert.equal(chatCalls,before+2);
 }
});
test('image inference POST failures remain ambiguous and are not submitted twice',async t=>{
 const s=await fixture();let chatCalls=0;
 t.mock.method(globalThis,'fetch',async (url,options)=>{
  if(options.method==='POST'){chatCalls++;return Response.json({}, {status:503});}
  return Response.json(String(url).endsWith('/ai/openai/models')?{data:[{id:'moonshotai/Kimi-K2.6',is_vision_supported:true,recommended_for_assistants:true}]}:{id:'test-assistant',model:'moonshotai/Kimi-K2.6'});
 });
 const params={token:s.sessionToken,action:'send',content:'Describe',messageId:randomUUID(),images:[image],provider:widgetAiProvider};
 await assert.rejects(actAsWidgetCustomer(pool,params),e=>e.ambiguous===true);
 const retry=await actAsWidgetCustomer(pool,params);assert.equal(chatCalls,1);assert.equal(retry.pendingReply,true);
 await assert.rejects(actAsWidgetCustomer(pool,{...params,messageId:randomUUID()}),e=>e.status===409);
});
