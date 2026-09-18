import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prepareAcdTestPool,seedQueue } from "./helpers/acd-test-db.mjs";
import { createWidget,updateWidgetDraft,publishWidget,getWidget,getPublishedWidget,updateWidget,restoreWidgetRevision } from "../lib/widgets/store.js";
import { DEFAULT_WIDGET_CONFIG,createDefaultWidgetConfig,parseWidgetConfig,assertPublishableWidgetConfig } from "../lib/widgets/config.js";
import { localizeWidgetConfig,widgetTranslations } from "../lib/widgets/locales.js";

const pool=await prepareAcdTestPool("acd_core_test_widget_management");
after(()=>pool.end());
const actor="test-admin";
async function configuredWidget(){
  const queueId=randomUUID();await seedQueue(pool,queueId,[]);
  await pool.query("INSERT INTO cc_queue_channels(queue_id,channel,enabled,max_concurrent,weight) VALUES($1,'chat',true,5,0.2)",[queueId]);
  let widget=await createWidget(pool,{name:randomUUID(),actor});
  const config=structuredClone(widget.draft.config);
  config.allowedOrigins=["https://customer.example.com"];
  config.channels.messaging.routing={queueId,queueName:"Support",queues:[{id:queueId,name:"Support"}]};
  widget=await updateWidgetDraft(pool,{id:widget.id,config,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor});
  return widget;
}
const publish=widget=>publishWidget(pool,{id:widget.id,expectedDraftId:widget.draft.id,expectedEditVersion:widget.draft.editVersion,actor},{provisionHandoff:async()=>({id:"test-shared-handoff"})});

test("reference configuration retains all visual, behavioral, locale and preview groups",()=>{
  const parsed=parseWidgetConfig(DEFAULT_WIDGET_CONFIG);
  for(const group of ["theme","dimensions","components","content","avatars","features","behavior","engagement","targeting","decisions","preview","callbacks"])assert.ok(parsed[group]);
  assert.equal(parsed.channels.voice.enabled,false);
  assert.equal("genesys" in parsed.channels.messaging,false);
});
test("new widgets start in en-US with English copy and preview locale",async()=>{
  const widget=await createWidget(pool,{name:randomUUID(),actor});
  const config=widget.draft.config;
  assert.equal(config.locale,"en-US");
  assert.equal(config.preview.decisionContext["visitor.locale"],"en-US");
  for(const [key,value] of Object.entries(widgetTranslations("en-US").content))assert.equal(config.content[key],value);
  assert.equal(config.components.messages.customerLabel,"You");
  assert.equal(config.avatars.customer.value,"YOU");
  assert.equal(config.components.launcher.label,"Contact us");
});
test("legacy Polish widgets retain localized backfills and custom copy",()=>{
  const config=parseWidgetConfig({schemaVersion:1,locale:"pl-PL",content:{title:"Custom support title"}});
  assert.equal(config.locale,"pl-PL");
  assert.equal(config.content.title,"Custom support title");
  assert.equal(config.content.agentTypingMessage,widgetTranslations("pl-PL").content.agentTypingMessage);
});
test("section reset defaults follow the current widget locale without mutating legacy defaults",()=>{
  const before=structuredClone(DEFAULT_WIDGET_CONFIG);
  for(const [locale,initials] of [["en-US","YOU"],["pl-PL","TY"],["de-DE","SIE"]]){
    const config=createDefaultWidgetConfig(locale),translation=widgetTranslations(locale);
    assert.equal(config.locale,locale);
    assert.equal(config.preview.decisionContext["visitor.locale"],locale);
    for(const [key,value] of Object.entries(translation.content))assert.equal(config.content[key],value);
    assert.equal(config.components.messages.assistantLabel,translation.labels.assistant);
    assert.equal(config.components.launcher.label,translation.launcherLabel);
    assert.equal(config.avatars.customer.value,initials);
    config.content.title="Edited";
  }
  assert.deepEqual(DEFAULT_WIDGET_CONFIG,before);
});
test("publish exposes an immutable revision; subsequent draft edits stay private",async()=>{
  const widget=await configuredWidget();const published=await publish(widget);
  assert.equal(published.published.version,1);assert.equal(published.draft.version,2);
  const before=await getPublishedWidget(pool,published.publicId);
  const draft=structuredClone(published.draft.config);draft.content.greeting="Edited draft only";
  await updateWidgetDraft(pool,{id:widget.id,config:draft,expectedDraftId:published.draft.id,expectedEditVersion:published.draft.editVersion,actor});
  assert.deepEqual((await getPublishedWidget(pool,published.publicId)).config,before.config);
  await assert.rejects(updateWidgetDraft(pool,{id:widget.id,config:draft,expectedDraftId:published.draft.id,expectedEditVersion:published.draft.editVersion,actor}),/draft changed/);
  await assert.rejects(publish(published),/draft changed/);
});
test("clone copies the complete draft and every uploaded preview, with a separate public identity",async()=>{
  let source=await configuredWidget();
  const variant="desktop-responsive__landscape";
  await pool.query("INSERT INTO cc_widget_preview_assets(widget_id,variant,bytes) VALUES($1,$2,$3)",[source.id,variant,Buffer.from("test-image")]);
  const config=localizeWidgetConfig(source.draft.config,"pl-PL");config.content.title="Custom clone title";
  config.preview.decisionContext["visitor.locale"]="pl-PL";
  config.preview.backgrounds[variant].backgroundImageUrl=`/api/admin/widgets/${source.id}/preview-background?variant=${variant}`;
  source=await updateWidgetDraft(pool,{id:source.id,config,expectedDraftId:source.draft.id,expectedEditVersion:source.draft.editVersion,actor});
  const clone=await createWidget(pool,{name:randomUUID(),cloneFromId:source.id,actor});
  assert.notEqual(clone.publicId,source.publicId);assert.equal(clone.published,null);
  assert.equal(clone.draft.config.locale,"pl-PL");
  assert.deepEqual(clone.draft.config.content,source.draft.config.content);
  assert.equal(clone.draft.config.preview.decisionContext["visitor.locale"],"pl-PL");
  assert.deepEqual(clone.draft.config.theme,source.draft.config.theme);
  assert.ok(clone.draft.config.preview.backgrounds[variant].backgroundImageUrl.includes(clone.id));
  assert.equal((await pool.query("SELECT bytes FROM cc_widget_preview_assets WHERE widget_id=$1",[clone.id])).rows[0].bytes.toString(),"test-image");
});
test("disable stops public bootstrap and restoring an old revision only changes the draft",async()=>{
  const first=await publish(await configuredWidget());
  const current=await publish(first);
  const restored=await restoreWidgetRevision(pool,{id:current.id,revisionId:first.published.id,expectedDraftId:current.draft.id,expectedEditVersion:current.draft.editVersion,actor});
  assert.equal(restored.published.version,2);
  assert.deepEqual(restored.draft.config,first.published.config);
  await updateWidget(pool,{id:current.id,name:current.name,enabled:false,actor});
  assert.equal(await getPublishedWidget(pool,current.publicId),null);
  assert.equal((await getWidget(pool,current.id)).draft.version,3);
});
test("publication rejects missing origins, unavailable channels and disabled queues",async()=>{
  assert.throws(()=>assertPublishableWidgetConfig(DEFAULT_WIDGET_CONFIG),/embedding origin/);
  const widget=await configuredWidget();
  const voice=structuredClone(widget.draft.config);voice.channels.voice.enabled=true;
  assert.throws(()=>assertPublishableWidgetConfig(voice),/Voice AI assistant/);
  await pool.query("UPDATE cc_queue_channels SET enabled=false WHERE queue_id=$1",[widget.draft.config.channels.messaging.routing.queueId]);
  await assert.rejects(publish(widget),/Chat enabled/);
});
