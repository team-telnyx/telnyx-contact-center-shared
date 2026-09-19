import './process-shim.js';
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import ChatInteractionDetail from '../../components/contact-center/ChatInteractionDetail';
import WhatsAppAdmin from '../../components/whatsapp/WhatsAppAdmin';
import {WHATSAPP_OUTBOUND_MIME_TYPES,WHATSAPP_MEDIA_RULES,WHATSAPP_MAX_FILES} from '../../lib/whatsapp/policy.mjs';

const now=Date.now();
let providerSeq=0;
// Every provider-backed message carries the Telnyx message id; reactions are addressed by it.
const delivery=(status,kind='text',content={})=>({status,direction:status==='received'?'inbound':'outbound',provider:'whatsapp',kind,content,provider_message_id:`tx-${++providerSeq}`});
const fixture=window.fixture={requests:[],db:{version:3,messages:[
  {id:'m1',seq:'1',sender_role:'customer',sender_id:'+15550001111',client_id:'wa-in-1',body:'Hi, is my order 1234 ready for pickup?',created_at:new Date(now-600000).toISOString(),attachments:[],delivery:delivery('received')},
  {id:'m2',seq:'2',sender_role:'agent',sender_id:'agent-1',client_id:'c-1',body:'Hello! Let me check that for you.',created_at:new Date(now-500000).toISOString(),first_name:'Alex',last_name:'Agent',attachments:[],delivery:delivery('delivered')},
  {id:'m3',seq:'3',sender_role:'agent',sender_id:'agent-1',client_id:'c-2',body:'Your order will be ready at 4 pm 😀',created_at:new Date(now-400000).toISOString(),first_name:'Alex',last_name:'Agent',attachments:[],delivery:{...delivery('read'),reactions:[{emoji:'😮',sender_role:'customer',sender_id:'+15550001111',message_id:'m9',created_at:new Date(now-350000).toISOString(),status:'received'}]}},
  {id:'m4',seq:'4',sender_role:'customer',sender_id:'+15550001111',client_id:'wa-in-2',body:'Office',created_at:new Date(now-300000).toISOString(),attachments:[],delivery:delivery('received','location',{location:{latitude:'52.23',longitude:'21.01',name:'Office',address:'Main St 1'}})},
],draft:{body:'',version:'0'},whatsapp:{customer_address:'+15550001111',customer_name:'Anna Nowak',business_number:'+14155550100',number_name:'Support WhatsApp',sending_enabled:true,thread_state:'open',
  window:{open:true,expiresAt:new Date(now+5*3600000).toISOString(),remainingMs:5*3600000},mediaPolicy:{mimeTypes:WHATSAPP_OUTBOUND_MIME_TYPES,maxFiles:WHATSAPP_MAX_FILES,rules:WHATSAPP_MEDIA_RULES}}}};
const templates=[{id:'tpl-1',name:'order_update',language:'en_US',category:'UTILITY',status:'APPROVED',components:[{type:'BODY',text:'Hi {{1}}, your order {{2}} is ready.',example:{body_text:[['Anna','WA-1']]}}],
  fields:[{key:'body:1',label:'Body {{1}}',type:'body',parameterIndex:1,defaultValue:'Anna'},{key:'body:2',label:'Body {{2}}',type:'body',parameterIndex:2,defaultValue:''}],preview:{header:'',headerFormat:'NONE',body:'Hi {{1}}, your order {{2}} is ready.',footer:'',buttons:[]}}];
const overview={credentials:{source:'backup',resolved:true,checkedAt:new Date(now-60000).toISOString(),wabaCount:1,checks:[{source:'primary',configured:true,wabaCount:0,error:null},{source:'backup',configured:true,wabaCount:1,error:null}]},
  credentialsConfigured:true,webhookKeyConfigured:true,backupWebhookKeyConfigured:true,webhookPath:'/api/webhooks/telnyx/whatsapp',webhookUrl:'https://contact.example.com/api/webhooks/telnyx/whatsapp',webhookError:null,
  numbers:[{id:'n1',version:2,phone_number:'+14155550100',phone_number_id:'pn-1',waba_id:'waba-1',display_name:'Support',messaging_profile_id:'mp-cc',name:'Support WhatsApp',queue_id:'q-support',queue_name:'Support',profile_name:'Contact Center WhatsApp',queue_whatsapp_enabled:true,routing_enabled:true,sending_enabled:true,backlog:0,threads:3,open_windows:1,last_inbound_at:new Date(now-300000).toISOString(),last_error:null},
    {id:'n2',version:1,phone_number:'+14155550102',phone_number_id:'pn-3',waba_id:'waba-1',display_name:'Sales',messaging_profile_id:'mp-cc',name:'Sales WhatsApp',queue_id:'q-sales',queue_name:'Sales',profile_name:'Contact Center WhatsApp',queue_whatsapp_enabled:false,routing_enabled:false,sending_enabled:false,backlog:2,threads:0,open_windows:0,last_inbound_at:null,last_error:null}],
  profiles:[{id:'mp-cc',name:'Contact Center WhatsApp',credential_source:'backup',webhook_url:'https://contact.example.com/api/webhooks/telnyx/whatsapp',webhook_api_version:'2',webhook_verified_at:new Date(now-3600000).toISOString(),number_count:2,last_error:null}],
  accounts:[{id:'acct-1',waba_id:'waba-1',name:'Telnyx Internal',credential_source:'backup'}],
  queues:[{id:'q-support',name:'Support',whatsapp_enabled:true},{id:'q-sales',name:'Sales',whatsapp_enabled:false}],audit:[{id:1,action:'save_number',resource_id:'n1',actor_name:'Demo',created_at:new Date(now-7200000).toISOString()}],
  ingestionFailures:[{event_id:'evt-1',event_type:'message.received',status:'unmatched',attempt_count:1,last_error:null,received_at:new Date(now-90000).toISOString(),from_number:'+15550009999',to_number:'+14155550199',text:'Hello?'}],
  copilot:{model:'meta-llama/Llama-3.3-70B-Instruct',bucketIds:[],maxTokens:6000}};
const phoneNumbers=[{phoneNumber:'+14155550100',phoneNumberId:'pn-1',wabaId:'waba-1',displayName:'Support',qualityRating:'GREEN',status:'CONNECTED',enabled:true,callingEnabled:false,managed:{id:'n1',name:'Support WhatsApp',queue_id:'q-support'}},
  {phoneNumber:'+14155550101',phoneNumberId:'pn-2',wabaId:'waba-1',displayName:'Demo portal',qualityRating:'YELLOW',status:'CONNECTED',enabled:true,callingEnabled:true,managed:null},
  {phoneNumber:'+14155550102',phoneNumberId:'pn-3',wabaId:'waba-1',displayName:'Sales',qualityRating:'UNKNOWN',status:'PENDING',enabled:false,callingEnabled:false,managed:{id:'n2',name:'Sales WhatsApp',queue_id:'q-sales'}}];
const json=(body,ok=true)=>({ok,status:ok?200:409,json:async()=>body,headers:{get:()=>null}});
const tinyPng='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
window.fetch=async(url,options={})=>{
  const form=typeof FormData!=='undefined'&&options.body instanceof FormData;
  fixture.requests.push({url,method:options.method||'GET',body:form?null:options.body||null,form:form?{message:options.body.get('message'),files:options.body.getAll('file').map(f=>({name:f.name,type:f.type,size:f.size}))}:null});
  if(url.startsWith('/api/contact-center/whatsapp/wa-1/copilot'))return json({settings:{model:'meta-llama/Llama-3.3-70B-Instruct',bucketIds:[],maxTokens:6000},latest:null});
  if(url==='/api/contact-center/whatsapp/wa-1/templates')return json({templates});
  if(url==='/api/contact-center/whatsapp/wa-1'&&!options.method)return json({work:{id:'wa-1',version:String(fixture.db.version),state:'active',queue_id:'q-support',conversation_id:'conv-1',attributes:{business_number:'+14155550100',number_name:'Support WhatsApp',customer_number:'+15550001111'}},
    messages:fixture.db.messages,draft:fixture.db.draft,customerName:'Anna Nowak',agent:{first_name:'Alex',last_name:'Agent'},customerTyping:false,wrapupCodes:[],attachmentPolicy:null,whatsapp:fixture.db.whatsapp});
  const append=(body,kind,extra={})=>{const message={id:'m'+(fixture.db.messages.length+1),seq:String(fixture.db.messages.length+1),sender_role:'agent',sender_id:'agent-1',client_id:extra.clientId||crypto.randomUUID(),body,created_at:new Date().toISOString(),first_name:'Alex',last_name:'Agent',attachments:extra.attachments||[],delivery:delivery('queued',kind,extra.content||{})};fixture.db.messages.push(message);return message;};
  if(url==='/api/contact-center/whatsapp/wa-1/messages'&&form){
    const input=JSON.parse(options.body.get('message'));const files=options.body.getAll('file');
    const messages=files.map((file,index)=>append(index===0&&input.body?input.body:file.name,input.mediaKinds?.[index]||'image',{attachments:[{id:'a'+index,name:file.name,content_type:file.type,byte_size:file.size,url:tinyPng}]}));
    fixture.db.version++;fixture.db.draft={body:'',version:String(Number(fixture.db.draft.version)+1)};
    return json({ok:true,message:messages[0],messages,status:'queued',version:String(fixture.db.version),draftVersion:fixture.db.draft.version});
  }
  if(url==='/api/contact-center/whatsapp/wa-1'&&options.method==='POST'){
    const input=JSON.parse(options.body);
    if(input.action==='draft'){fixture.db.draft={body:input.body,version:String(Number(fixture.db.draft.version)+1)};return json({body:input.body,version:fixture.db.draft.version});}
    if(input.action==='send'&&input.reaction){
      const target=fixture.db.messages.find(m=>m.id===input.reaction.messageId);
      target.delivery.reactions=input.reaction.emoji?[{emoji:input.reaction.emoji,sender_role:'agent',sender_id:'agent-1',message_id:'r-'+input.commandId,created_at:new Date().toISOString(),status:'queued'}]:[];
      fixture.db.version++;fixture.db.draft={...fixture.db.draft,version:String(Number(fixture.db.draft.version)+1)};
      return json({ok:true,message:target,status:'queued',version:String(fixture.db.version),draftVersion:fixture.db.draft.version});
    }
    if(input.action==='send'){
      const message=input.template?append(`Hi ${input.template.values['body:1']}, your order ${input.template.values['body:2']} is ready.`,'template',{content:{template:{name:'order_update',language:'en_US'}},clientId:input.commandId})
        :input.location?append(`[Location: ${input.location.name||`${input.location.latitude}, ${input.location.longitude}`}]`,'location',{content:{location:{latitude:String(input.location.latitude),longitude:String(input.location.longitude),name:input.location.name,address:input.location.address}},clientId:input.commandId})
        :input.contactIds?append('[Contact: Anna Nowak]','contacts',{content:{contacts:[{name:'Anna Nowak',phones:['+48600000001'],emails:['anna@example.com'],company:'Telnyx'}]},clientId:input.commandId})
        :append(input.body,'text',{clientId:input.commandId});
      fixture.db.version++;fixture.db.draft={body:'',version:String(Number(fixture.db.draft.version)+1)};
      return json({ok:true,message,status:'queued',version:String(fixture.db.version),draftVersion:fixture.db.draft.version});
    }
    return json({ok:true});
  }
  if(url.startsWith('/api/contact-center/media/geocode'))return json({results:[{id:'1',name:'Telnyx office',address:'Nowy Świat 1, 00-497 Warszawa, Polska',label:'Nowy Świat 1, Śródmieście, Warszawa, 00-497, Polska',latitude:52.2297,longitude:21.0122,category:'office'}]});
  if(url.startsWith('/api/contacts?'))return json({rows:[{id:'ct-1',display_name:'Anna Nowak',first_name:'Anna',last_name:'Nowak',company_name:'Telnyx',mobile:'+48600000001',email_address_1:'anna@example.com'}],count:1});
  if(url.startsWith('/api/contact-center/media/pexels')){
    const params=new URL(url,'http://x').searchParams;
    if(params.get('photoId'))return {ok:true,status:200,headers:{get:key=>key==='x-pexels-filename'?'sunset-42.jpg':null},blob:async()=>new Blob([new Uint8Array([0xff,0xd8,0xff,0xe0,0,16,74,70,73,70])],{type:'image/jpeg'}),json:async()=>({})};
    return json({photos:[{id:42,title:'Sunset',alt:'Sunset over the sea',photographer:'Kim',photographer_url:'',pexels_url:'',width:4000,height:3000,avg_color:'#224466',src:{tiny:tinyPng,small:tinyPng,medium:tinyPng,large:tinyPng}}],page:1,perPage:30,totalResults:1,nextPage:null});
  }
  if(url.startsWith('/api/admin/whatsapp')){
    const params=new URL(url,'http://x').searchParams;
    if(options.method==='POST'){fixture.adminActions=(fixture.adminActions||[]).concat(JSON.parse(options.body));return json({ok:true,result:{}});}
    const resource=params.get('resource');
    if(!resource)return json(overview);
    if(resource==='phone-numbers')return json({data:phoneNumbers});
    if(resource==='profiles')return json({data:[{id:'mp-cc',name:'Contact Center WhatsApp',enabled:true,webhook_url:overview.webhookUrl,webhook_api_version:'2',number_pool:false,connected:true,webhook_matches:true},{id:'mp-portal',name:'Demo portal WhatsApp',enabled:true,webhook_url:'https://demo.example.com/api/messaging/whatsapp/webhook',webhook_api_version:'2',number_pool:false,connected:false,webhook_matches:false}]});
    if(resource==='accounts')return json({data:[{id:'acct-0',wabaId:'waba-0',name:'Telnyx Internal',status:'INACTIVE',phoneNumbersCount:0,businessVerificationStatus:'unknown',accountReviewStatus:'UNKNOWN',country:'',createdAt:null,connected:false},{id:'acct-1',wabaId:'waba-1',name:'Telnyx Internal',status:'ACTIVE',phoneNumbersCount:3,businessVerificationStatus:'verified',accountReviewStatus:'APPROVED',country:'US',createdAt:new Date(now-86400000*30).toISOString(),connected:true}]});
    if(resource==='account')return json({account:{id:'acct-1',wabaId:'waba-1',name:'Telnyx Internal',status:'ACTIVE',phoneNumbersCount:3,businessVerificationStatus:'verified',accountReviewStatus:'APPROVED',country:'US',createdAt:new Date(now-86400000*30).toISOString()},
      settings:{id:'acct-1',name:'Telnyx Internal',timezone:'Europe/Warsaw',webhookUrl:'https://demo.example.com/api/webhooks/whatsapp/account',webhookFailoverUrl:'',webhookEnabled:true,webhookEvents:['messages','account_updates'],updatedAt:new Date(now-3600000).toISOString()},phoneNumbers});
    if(resource==='templates')return json({data:templates.map(t=>({...t,waba_id:'waba-1',whatsapp_business_account:{id:'waba-1'}}))});
    if(resource==='phone-number')return json({phoneNumber:params.get('phone'),profile:{display_name:'Support',category:'PROFESSIONAL_SERVICES',about:'We help',description:'',email:'',website:'https://example.com',address:'',profile_id:'mp-cc'},calling:{enabled:false},photo:{},managed:params.get('phone')==='+14155550100'?{id:'n1',name:'Support WhatsApp'}:null});
    if(resource==='deliveries')return json({data:[{message_id:'m2',status:'read',direction:'outbound',provider_message_id:'wa-1',kind:'text',error_code:null,error_detail:null,created_at:new Date(now-500000).toISOString(),text:'Hello! Let me check that for you.',business_number:'+14155550100',customer_address:'+15550001111',customer_name:'Anna Nowak',agent:'alex'},
      {message_id:'m9',status:'delivery_failed',direction:'outbound',provider_message_id:'wa-9',kind:'image',error_code:'131026',error_detail:'Message undeliverable',created_at:new Date(now-400000).toISOString(),text:'receipt.jpg',business_number:'+14155550100',customer_address:'+15550002222',customer_name:null,agent:'alex'}]});
  }
  throw new Error('Unexpected '+url);
};
function App(){
  const [route,setRoute]=useState('desktop');
  useEffect(()=>{fixture.navigate=setRoute;},[]);
  const interaction={id:'wa-1',channel:'whatsapp',interaction_type:'whatsapp',state:'active',version:'3',queue_name:'Support',from_name:'Anna Nowak',customer_address:'+15550001111',created_at:new Date(now-600000).toISOString(),attributes:{business_number:'+14155550100',number_name:'Support WhatsApp'}};
  return <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
    {route==='desktop'?<ChatInteractionDetail interaction={interaction} onChanged={()=>{}}/>:<div className="flex min-h-0 flex-1 flex-col"><WhatsAppAdmin/></div>}
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
