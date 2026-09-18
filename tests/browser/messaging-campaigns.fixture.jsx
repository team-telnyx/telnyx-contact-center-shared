import './process-shim.js';
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import SmsAdmin from '../../components/sms/SmsAdmin';
import MessagingCampaignPanel from '../../components/contact-center/outbound/MessagingCampaignPanel';
import MessagingSettingsCard from '../../components/contact-center/outbound/MessagingSettingsCard';
import {CampaignSettingsForm} from '../../app/(portal)/supervisor/outbound-dialer/page';
import {composeSmsMessage,extractSmsTemplateVariables} from '../../lib/sms/templates.mjs';
import {resolveVariableValues,systemVariableValues} from '../../lib/outbound-dialer/messaging/variables.mjs';
import {resolveMessagingDestination} from '../../lib/outbound-dialer/messaging/destination.mjs';
import {normalizeMessagingSettings} from '../../lib/outbound-dialer/messaging/settings.mjs';

const now=Date.now();
const contacts=[{id:'c1',row_data:{'First Name':'Anna',Mobile:'+48600000001',code:'A1'},contact_methods:{number:{mobile:'+48600000001'}}},{id:'c2',row_data:{'First Name':'Bob',Mobile:'',code:'B2'},contact_methods:{number:{mobile:''}}}];
const fixture=window.fixture={requests:[],db:{templates:[{id:'t1',name:'Order ready',category:'utility',language:'en',body:'Hi {{first_name}}, your order {{code}} is ready.',variables:['first_name','code'],sample_values:{first_name:'Anna',code:'A1'},footer_mode:'inherit',status:'active',version:1,campaign_count:1,updated_at:new Date(now-3600000).toISOString()}]},settings:null};
const overview={credentialsConfigured:true,webhookKeyConfigured:true,webhookPath:'/api/webhooks/telnyx/sms',webhookUrl:'https://contact.example.com/api/webhooks/telnyx/sms',webhookError:null,numbers:[],profiles:[{id:'mp-cc',name:'Contact Center',webhook_url:'https://contact.example.com/api/webhooks/telnyx/sms',webhook_api_version:'2',webhook_verified_at:new Date(now-3600000).toISOString(),number_count:1,last_error:null}],queues:[],audit:[],ingestionFailures:[],copilot:{model:'meta-llama/Llama-3.3-70B-Instruct',bucketIds:[],maxTokens:6000}};
// Live object so a test can change the workspace opt-out policy and refresh.
const footerPolicy=fixture.footerPolicy={required:true,text:'Reply STOP to opt out',maxSegments:3};
const outboundSettings={callable_window:{earliest:'09:00',latest:'20:00',timezone:'Europe/Warsaw'},messaging:normalizeMessagingSettings({enabled_channels:{sms:true},sms:{opt_out_footer_text:'Reply STOP to opt out',max_segments_per_message:3}})};
const json=(body,ok=true)=>({ok,status:ok?200:400,json:async()=>body});
// Supervisor → Outbound Dialer renders these forms in a 380px context panel.
// `CampaignSettingsForm` brings its own scroll container, the standalone
// messaging panel does not, so the shell supplies one.
function PanelShell({children,scroll=true}){
  return <aside data-testid="config-panel" className="flex h-screen min-h-0 w-[380px] flex-col overflow-hidden border bg-card">
    <div className="h-16 shrink-0 border-b px-4 flex flex-col justify-center"><h2 className="text-sm font-semibold">Context settings</h2><p className="text-xs text-muted-foreground">Campaigns configuration</p></div>
    {scroll?<div data-testid="config-panel-scroll" className="@container flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 space-y-4">{children}</div>:children}
  </aside>;
}
window.fetch=async(url,options={})=>{
  fixture.requests.push({url,method:options.method||'GET',body:options.body||null});
  if(url.startsWith('/api/admin/sms')){
    const params=new URL(url,'http://x').searchParams;
    if(options.method==='POST'){
      const input=JSON.parse(options.body);
      if(input.action==='save_template'){const row={id:'t'+(fixture.db.templates.length+1),name:input.name,category:input.category,language:input.language,body:input.body,variables:extractSmsTemplateVariables(input.body),sample_values:input.sample_values||{},footer_mode:input.footer_mode,footer_text:input.footer_text||'',status:'active',version:1,campaign_count:0,updated_at:new Date().toISOString()};fixture.db.templates.push(row);return json({ok:true,result:row});}
      return json({ok:true,result:{}});
    }
    const resource=params.get('resource');
    if(!resource)return json({...overview,footerPolicy:{...footerPolicy}});
    if(resource==='templates')return json({data:fixture.db.templates});
    if(resource==='numbers')return json({data:[]});
    if(resource==='profiles')return json({data:[]});
  }
  if(url==='/api/contact-center/outbound-dialer/messaging/preview'){
    const input=JSON.parse(options.body);const config=input.campaign.metadata.messaging;const contact=contacts[input.sample_index||0]||null;
    const template=fixture.db.templates.find(t=>t.id===config.template.sms.template_id);
    const destination=resolveMessagingDestination({channel:'sms',destinationFields:config.destination_fields,rowData:contact?.row_data,contactMethods:contact?.contact_methods});
    const resolved=resolveVariableValues(config.variable_mapping,{rowData:contact?.row_data||{},contactMethods:contact?.contact_methods||{},system:systemVariableValues({campaign:input.campaign,senderAddress:'+14155550100'})});
    const composed=template?composeSmsMessage({body:template.body,values:resolved.values,footerText:'Reply STOP to opt out'}):{text:'',missing:[],segments:null};
    const unmapped=template?template.variables.filter(key=>!config.variable_mapping.some(row=>row.key===key&&(row.value||row.fallback))):[];
    const warnings=[];if(!destination.address)warnings.push('No valid phone number in the selected destination fields.');if(unmapped.length)warnings.push(`Unmapped variables: ${unmapped.join(', ')}.`);if(composed.missing.length)warnings.push(`No value for: ${composed.missing.join(', ')} (policy: skip).`);
    return json({ok:true,preview:{ok:Boolean(template&&destination.address&&!warnings.length),channel:'sms',destination,values:resolved.values,missing:composed.missing,unmapped,text:composed.text,segments:composed.segments,warnings,contact:contact?{id:contact.id,row_data:contact.row_data,contact_methods:contact.contact_methods}:null},sample:{index:input.sample_index||0,total:contacts.length,contact_record_id:contact?.id||null}});
  }
  if(url.endsWith('/messaging/validate'))return json({ok:true,validation:{generated_at:new Date().toISOString(),ok:true,limited:false,counts:{total:3,scanned:3,sendable:1,missing_destination:1,filtered_out:0,dnc:0,opted_out:0,consent_missing:0,test_mode_allowlist:1,missing_variables:0,too_many_segments:0,not_valid:0,estimated_parts:1},missing_by_variable:{},problems:[]}});
  if(url.endsWith('/messaging/test-send'))return json({ok:true,result:{accepted:true,state:'accepted',text:'Hi Anna, your order A1 is ready.\nReply STOP to opt out',reason:null}});
  throw new Error('Unexpected '+url);
};
const contactList={id:'list-1',name:'Audience',custom_field_schema:[{name:'First Name',type:'first_name'},{name:'Mobile',type:'phone'},{name:'code',type:'text'}],metadata:{csv_import_settings:{column_mappings:{Mobile:['number:mobile']},selected_columns:['First Name','Mobile','code']}},row_data_columns:['First Name','Mobile','code']};
const campaignFormLists=[contactList];
const senders={sms:[{id:'n1',phone_number:'+14155550100',name:'Sales line',queue_name:'Sales',sending_enabled:true,routing_enabled:true},{id:'n2',phone_number:'+14155550101',name:'Support line',queue_name:'Support',sending_enabled:false,routing_enabled:true}],
  whatsapp:[{id:'w1',phone_number:'+14155550900',name:'WhatsApp line',queue_name:'Sales',sending_enabled:true,routing_enabled:true,messaging_profile_id:'wa-profile',waba_id:'waba-1',quality_rating:'GREEN'},
    {id:'w2',phone_number:'+14155550901',name:'Unlinked line',queue_name:'Support',sending_enabled:true,routing_enabled:true,messaging_profile_id:null,waba_id:'waba-1'}],
  email:[{id:'m1',address:'campaigns@cc.example.com',phone_number:'campaigns@cc.example.com',name:'Campaigns',queue_name:'Sales',sending_enabled:true,routing_enabled:true},
    {id:'m2',address:'paused@cc.example.com',phone_number:'paused@cc.example.com',name:'Paused',queue_name:'Support',sending_enabled:false,routing_enabled:true}]};
const channelTemplates={
  whatsapp:[{id:'wa1',channel:'whatsapp',name:'order_ready',language:'en',category:'MARKETING',status:'APPROVED',approved:true,header_format:'TEXT',body:'Hi {{1}}, order {{2}} is ready.',components:[],
    variables:[{key:'body:1',label:'Body {{1}}',kind:'positional',required:true},{key:'body:2',label:'Body {{2}}',kind:'positional',required:true}]}],
  email:[{id:'em1',channel:'email',name:'Order ready',language:'',category:'email',subject:'{{first_name}}, your order is ready',html_body:'<p>Hi {{first_name}}</p>',text_body:'Hi {{first_name}}',body:'Hi {{first_name}}',
    variables:[{key:'first_name',label:'first_name',kind:'named',required:true}]}]};
function CampaignRoute(){
  const [draft,setDraft]=useState({id:'camp-1',name:'Autumn promo',channel:'sms',mode:'broadcast',contact_list_id:'list-1',retry_policy:{maxAttempts:2},metadata:{messaging:{}}});
  const [templateOverride,setTemplateOverride]=useState(null);
  // The page sets this when the draft differs from the stored campaign, e.g.
  // right after the channel of a saved voice campaign is switched to SMS.
  const [unsaved,setUnsaved]=useState(false);
  useEffect(()=>{fixture.draft=draft;},[draft]);
  useEffect(()=>{fixture.setChannel=channel=>setDraft(d=>({...d,channel,metadata:{messaging:{}}}));fixture.setTemplates=setTemplateOverride;fixture.setUnsaved=setUnsaved;},[]);
  const update=patch=>setDraft(d=>({...d,...patch}));
  const updateMetadata=patch=>setDraft(d=>({...d,metadata:{...(d.metadata||{}),...patch}}));
  const messaging=draft.metadata.messaging||{};
  const missing=[];if(!(messaging.destination_fields||[]).length)missing.push('destination_fields');if(!(messaging.sender?.[draft.channel]?.number_ids||[]).length&&!messaging.sender?.[draft.channel]?.number_id&&!messaging.sender?.[draft.channel]?.mailbox_id)missing.push('sender');if(!messaging.template?.[draft.channel]?.template_id)missing.push('template');
  return <PanelShell><MessagingCampaignPanel draft={draft} update={update} updateMetadata={updateMetadata} contactLists={[contactList]} outboundSettings={outboundSettings} senders={senders} templates={templateOverride||{sms:fixture.db.templates,...channelTemplates}} requirements={{missing}} unsaved={unsaved}/></PanelShell>;
}
function SettingsRoute(){
  const [value,setValue]=useState(outboundSettings.messaging);
  const [section,setSection]=useState('shared');
  useEffect(()=>{fixture.settings=value;},[value]);
  return <PanelShell><div className="flex flex-wrap gap-2">{['shared','sms','whatsapp','email'].map(id=><button key={id} type="button" data-testid={`settings-section-${id}`} className="rounded-md border px-3 py-1 text-xs" onClick={()=>setSection(id)}>{id.toUpperCase()}</button>)}</div><MessagingSettingsCard section={section} value={value} onChange={setValue} senders={senders}/></PanelShell>;
}
// The real campaign form from the dialer page: selecting a template must not
// re-register the header save action on every render (React #185 white screen).
const campaignRecord={id:'camp-1',name:'Autumn promo',channel:'sms',mode:'broadcast',status:'draft',contact_list_id:'list-1',retry_policy:{maxAttempts:2},metadata:{messaging:{}}};
const campaignForms=[{id:'f1',name:'Qualification script',schema:{fields:[{id:'fld1',type:'text',variableName:'customer_reference',label:'Customer reference number'},{id:'fld2',type:'select',variableName:'outcome',label:'Call outcome'}]}}];
const campaignFormSchema={channels:['voice','sms','whatsapp','email'],messagingChannels:['sms','whatsapp','email'],messagingChannelsAvailable:['sms'],messagingModes:['broadcast'],campaignModes:['preview','progressive'],campaignStatuses:['draft','ready'],handlerTypes:['queue'],contactFieldTypes:['text','phone'],standardContactColumns:[]};
const campaignFormHandlers={queue:[{id:'q1',name:'Sales'}],call_flow:[],workflow:[],ai_assistant:[]};
const campaignFormTemplates={sms:fixture.db.templates};
const saveCampaignStub=async()=>null;
const emptyList=[];
// The real dialer campaign form. Every prop is stable, exactly as the page
// passes them, so any re-render loop comes from the component under test.
// Production has all three messaging channels available, so the form has to
// distinguish "not built yet" from "switched off under Settings".
const allChannelsSchema={...campaignFormSchema,messagingChannelsAvailable:['sms','whatsapp','email']};
function CampaignFormRoute(){
  // The page keeps the registered action in state, so a re-registration
  // re-renders the form: that feedback edge is what turned an unstable
  // dependency into an endless update loop.
  const [,setSaveAction]=useState(null);
  const [schema,setSchema]=useState(campaignFormSchema);
  const registerHeaderSaveAction=React.useCallback(action=>{fixture.saveActionRegistrations=(fixture.saveActionRegistrations||0)+1;setSaveAction(action);},[]);
  useEffect(()=>{fixture.setAllChannelsAvailable=all=>setSchema(all?allChannelsSchema:campaignFormSchema);},[]);
  return <PanelShell scroll={false}><CampaignSettingsForm campaign={campaignRecord} outboundSettings={outboundSettings} messagingSenders={senders} messagingTemplates={campaignFormTemplates}
    forms={campaignForms} contactLists={campaignFormLists} dncLists={emptyList} filters={emptyList} timeSets={emptyList} attemptControls={emptyList} handlerReferences={campaignFormHandlers}
    schema={schema} saveCampaign={saveCampaignStub} saving={false} registerHeaderSaveAction={registerHeaderSaveAction}/></PanelShell>;
}
function App(){
  const [route,setRoute]=useState('templates');
  useEffect(()=>{fixture.navigate=setRoute;},[]);
  return <div className="flex h-screen min-h-0 flex-col overflow-auto bg-background text-foreground">
    {route==='templates'?<div className="flex min-h-0 flex-1 flex-col"><SmsAdmin initialSection="templates"/></div>:route==='campaign'?<CampaignRoute/>:route==='campaign-form'?<CampaignFormRoute/>:<SettingsRoute/>}
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
