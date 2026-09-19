import './process-shim.js';
import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import ChatInteractionDetail from '../../components/contact-center/ChatInteractionDetail';
import SmsAdmin from '../../components/sms/SmsAdmin';

const now=Date.now();
const fixture=window.fixture={requests:[],db:{version:3,messages:[
  {id:'m1',seq:'1',sender_role:'customer',sender_id:'+15550001111',client_id:'tx-in-1',body:'Hi, is my order 1234 ready for pickup?',created_at:new Date(now-600000).toISOString(),attachments:[],delivery:{status:'received',direction:'inbound',encoding:'GSM-7',parts:1}},
  {id:'m2',seq:'2',sender_role:'agent',sender_id:'agent-1',client_id:'c-1',body:'Hello! Let me check that for you.',created_at:new Date(now-500000).toISOString(),first_name:'Alex',last_name:'Agent',attachments:[],delivery:{status:'delivered',direction:'outbound',encoding:'GSM-7',parts:1,provider_message_id:'tx-1'}},
  {id:'m3',seq:'3',sender_role:'agent',sender_id:'agent-1',client_id:'c-2',body:'Your order will be ready at 4 pm — see you soon 😀',created_at:new Date(now-400000).toISOString(),first_name:'Alex',last_name:'Agent',attachments:[],delivery:{status:'delivery_failed',direction:'outbound',encoding:'UCS-2',parts:1,provider_message_id:'tx-2',error_code:'40001',error_detail:'Destination unreachable'}},
  {id:'m4',seq:'4',sender_role:'customer',sender_id:'+15550001111',client_id:'tx-in-2',body:'Great, thanks!',created_at:new Date(now-300000).toISOString(),attachments:[],delivery:{status:'received',direction:'inbound',encoding:'GSM-7',parts:1}},
],draft:{body:'',version:'0'},sms:{customer_address:'+15550001111',business_number:'+14155550100',number_name:'Sales line',opted_out:false,sending_enabled:true,thread_state:'open'}}};
const overview={credentialsConfigured:true,webhookKeyConfigured:true,webhookPath:'/api/webhooks/telnyx/sms',webhookUrl:'https://contact.example.com/api/webhooks/telnyx/sms',webhookError:null,
  numbers:[{id:'n1',version:2,phone_number:'+14155550100',provider_number_id:'pn-1',messaging_profile_id:'mp-cc',name:'Sales line',queue_id:'q-sales',queue_name:'Sales',profile_name:'Contact Center',queue_sms_enabled:true,routing_enabled:true,sending_enabled:true,backlog:0,threads:12,opted_out:1,last_inbound_at:new Date(now-60000).toISOString()},
    {id:'n2',version:1,phone_number:'+14155550101',provider_number_id:'pn-2',messaging_profile_id:'mp-cc',name:'Support line',queue_id:'q-support',queue_name:'Support',profile_name:'Contact Center',queue_sms_enabled:false,routing_enabled:false,sending_enabled:false,backlog:3,threads:0,opted_out:0,last_inbound_at:null}],
  profiles:[{id:'mp-cc',name:'Contact Center',webhook_url:'https://contact.example.com/api/webhooks/telnyx/sms',webhook_api_version:'2',webhook_verified_at:new Date(now-3600000).toISOString(),number_count:2,last_error:null}],
  queues:[{id:'q-sales',name:'Sales',sms_enabled:true},{id:'q-support',name:'Support',sms_enabled:false}],audit:[{id:1,action:'save_number',resource_id:'n1',actor_name:'Demo',created_at:new Date(now-7200000).toISOString()}],
  ingestionFailures:[{event_id:'evt-1',event_type:'message.received',status:'unmatched',attempt_count:1,last_error:null,received_at:new Date(now-90000).toISOString(),from_number:'+15550009999',to_number:'+14155550199',text:'Hello?'}],
  copilot:{model:'meta-llama/Llama-3.3-70B-Instruct',bucketIds:[],maxTokens:6000}};
const json=(body,ok=true)=>({ok,status:ok?200:409,json:async()=>body});
window.fetch=async(url,options={})=>{
  fixture.requests.push({url,method:options.method||'GET',body:options.body||null});
  if(url.startsWith('/api/contact-center/sms/sms-1/copilot'))return json({settings:{model:'meta-llama/Llama-3.3-70B-Instruct',bucketIds:[],maxTokens:6000},latest:null});
  if(url==='/api/contact-center/sms/sms-1'&&!options.method)return json({work:{id:'sms-1',version:String(fixture.db.version),state:'active',queue_id:'q-sales',conversation_id:'conv-1',attributes:{business_number:'+14155550100',number_name:'Sales line'}},
    messages:fixture.db.messages,draft:fixture.db.draft,customerName:'+15550001111',agent:{first_name:'Alex',last_name:'Agent'},customerTyping:false,wrapupCodes:[],attachmentPolicy:null,sms:fixture.db.sms});
  if(url==='/api/contact-center/sms/sms-1'&&options.method==='POST'){
    const input=JSON.parse(options.body);
    if(input.action==='draft'){fixture.db.draft={body:input.body,version:String(Number(fixture.db.draft.version)+1)};return json({body:input.body,version:fixture.db.draft.version});}
    if(input.action==='send'){
      if(fixture.rejectNext){fixture.rejectNext=false;return json({error:'The customer opted out with STOP. Replies stay blocked until they text START.'},false);}
      const message={id:'m'+(fixture.db.messages.length+1),seq:String(fixture.db.messages.length+1),sender_role:'agent',sender_id:'agent-1',client_id:input.commandId,body:input.body,created_at:new Date().toISOString(),first_name:'Alex',last_name:'Agent',attachments:[],delivery:{status:'queued',direction:'outbound',encoding:'GSM-7',parts:1}};
      fixture.db.messages.push(message);fixture.db.version++;fixture.db.draft={body:'',version:String(Number(fixture.db.draft.version)+1)};
      return json({ok:true,message,status:'queued',version:String(fixture.db.version),draftVersion:fixture.db.draft.version});
    }
    return json({ok:true});
  }
  if(url.startsWith('/api/admin/sms')){
    const params=new URL(url,'http://x').searchParams;
    if(options.method==='POST'){fixture.adminActions=(fixture.adminActions||[]).concat(JSON.parse(options.body));return json({ok:true,result:{}});}
    const resource=params.get('resource');
    if(!resource)return json(overview);
    if(resource==='numbers')return json({data:[{id:'pn-1',phone_number:'+14155550100',messaging_profile_id:'mp-cc',type:'long-code',country_code:'US',sms_capable:true,two_way:true,managed:{id:'n1',queue_id:'q-sales'}},{id:'pn-2',phone_number:'+14155550101',messaging_profile_id:'mp-cc',type:'long-code',country_code:'US',sms_capable:true,two_way:true,managed:{id:'n2',queue_id:'q-support'}},{id:'pn-3',phone_number:'+14155550102',messaging_profile_id:'mp-other',type:'toll-free',country_code:'US',sms_capable:true,two_way:false,managed:null}]});
    if(resource==='profiles')return json({data:[{id:'mp-cc',name:'Contact Center',enabled:true,webhook_url:overview.webhookUrl,webhook_api_version:'2',number_pool:false,connected:true,webhook_matches:true},{id:'mp-other',name:'Marketing',enabled:true,webhook_url:null,webhook_api_version:'1',number_pool:true,connected:false,webhook_matches:false}]});
    if(resource==='deliveries')return json({data:[{message_id:'m2',status:'delivered',direction:'outbound',provider_message_id:'tx-1',encoding:'GSM-7',parts:1,error_code:null,error_detail:null,created_at:new Date(now-500000).toISOString(),text:'Hello! Let me check that for you.',business_number:'+14155550100',customer_address:'+15550001111',agent:'alex'},{message_id:'m3',status:'delivery_failed',direction:'outbound',provider_message_id:'tx-2',encoding:'UCS-2',parts:1,error_code:'40001',error_detail:'Destination unreachable',created_at:new Date(now-400000).toISOString(),text:'Your order will be ready at 4 pm',business_number:'+14155550100',customer_address:'+15550001111',agent:'alex'}]});
    if(resource==='opt-outs')return json({data:[{conversation_id:'conv-2',customer_address:'+15550002222',opted_out_at:new Date(now-86400000).toISOString(),last_inbound_at:new Date(now-86400000).toISOString(),business_number:'+14155550100',number_name:'Sales line'}]});
  }
  throw new Error('Unexpected '+url);
};
function App(){
  const [route,setRoute]=useState('desktop');
  useEffect(()=>{fixture.navigate=setRoute;},[]);
  const interaction={id:'sms-1',channel:'sms',interaction_type:'sms',state:'active',version:'3',queue_name:'Sales',from_name:'+15550001111',customer_address:'+15550001111',created_at:new Date(now-600000).toISOString(),attributes:{business_number:'+14155550100',number_name:'Sales line'}};
  return <div className="flex h-screen min-h-0 flex-col bg-background text-foreground">
    {route==='desktop'?<ChatInteractionDetail interaction={interaction} onChanged={()=>{}}/>:<div className="flex min-h-0 flex-1 flex-col"><SmsAdmin/></div>}
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
