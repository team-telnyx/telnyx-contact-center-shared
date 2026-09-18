import './process-shim.js';
import React from 'react';
import {createRoot} from 'react-dom/client';
import OutboundDialerPage from '../../app/(portal)/supervisor/outbound-dialer/page';
import {normalizeMessagingSettings} from '../../lib/outbound-dialer/messaging/settings.mjs';

// The real dialer page is rendered against synthetic resource records.
// Query parameters select one section and one permission combination.
try{localStorage.setItem('supervisor.outbound-dialer.activeSection',new URLSearchParams(window.location.search).get('section') || 'contact-lists');localStorage.removeItem('supervisor.outbound-dialer.settingsSection');}catch{}
const fixture=window.fixture={requests:[]};
const settings={id:'default',max_calls_per_agent:1,max_lines:12,max_line_utilization_percent:85,max_cps:40,compliance_abandon_threshold_seconds:2,global_max_attempts:5,dial_timeout_secs:30,callable_days:['mon','tue','wed','thu','fri'],
  callable_window:{earliest:'09:00',latest:'20:00',timezone:'Europe/Warsaw'},allowed_numbers:['+14155551000','+14155551001'],blending:{mode:'dynamic',reserve_agents:1,reserve_percent:10},
  answered_without_agent_policy:{mode:'announce_and_hangup',max_agent_connect_seconds:2,announcement_start_deadline_ms:500,max_announcement_seconds:10,max_abandon_rate_percent:3,abandon_rate_window_hours:24,retry_suppression_hours:72,announcement_message:'Hello',announcement_voice:'',announcement_language:'en-US'},
  messaging:normalizeMessagingSettings({enabled_channels:{sms:true},sms:{opt_out_footer_text:'Reply STOP to opt out'}})};
const overview={ok:true,schema:{channels:['voice','sms','whatsapp','email'],messagingChannels:['sms','whatsapp','email'],messagingChannelsAvailable:['sms'],messagingModes:['broadcast'],campaignModes:['preview','progressive','power','predictive','agentless_ai','agentless_flow','broadcast'],campaignStatuses:['draft','ready','paused','running','stopped','completed'],handlerTypes:['queue','ai_assistant','call_flow'],contactListStatuses:['draft','validating','validated'],dncListStatuses:['draft','active','paused'],attemptControlStatuses:['draft','active','paused'],dispositionClassifications:[],dispositionBusinessCategories:[],attemptResetPeriods:['daily'],contactFieldTypes:['text','phone','email'],standardContactColumns:[]},
  campaigns:[],contactLists:[],dncLists:[],forms:[],filters:[],timeSets:[],attemptControls:[],settings,handlerReferences:{queue:[],call_flow:[],workflow:[],ai_assistant:[]},
  inventoryNumbers:[...Array.from({length:14},(_,i)=>({id:`pn-${i+1}`,phone_number:`+1415555${String(1000+i).slice(0,4)}`,status:'active',connection_name:i%2?'Contact Center':'Marketing trunk',country_code:'US'})),{id:'pn-pl',phone_number:'+48600000001',status:'active',connection_name:'Warsaw trunk',country_code:'PL'}],
  messagingSenders:{sms:[{id:'n1',phone_number:'+14155550100',name:'Sales line',queue_name:'Sales',sending_enabled:true,routing_enabled:true}]},messagingTemplates:{sms:[]},executionDebugByCampaign:{}};
// Every request is answered below; this fixture cannot reach the dev API.
const lists=[{id:'fixture-list',name:'Synthetic contact list',status:'draft',description:'Fixture only',record_count:0,custom_field_schema:[]}];
Object.assign(overview, {contactLists:lists,dncLists:[{id:'fixture-dnc',name:'Synthetic DNC',status:'draft'}],filters:[{id:'fixture-filter',name:'Synthetic filter',status:'draft',contact_list_id:'fixture-list',conditions:[]}],timeSets:[{id:'fixture-time',name:'Synthetic time set',status:'draft',timezone:'UTC',windows:[]}],attemptControls:[{id:'fixture-attempt',name:'Synthetic attempts',status:'draft',max_attempts_per_contact:3}],campaigns:[{id:'fixture-campaign',name:'Synthetic campaign',status:'draft',channel:'voice',mode:'preview',metadata:{}}]});
const json=(body,ok=true)=>({ok,status:ok?200:400,json:async()=>body});
window.EventSource=class{constructor(){this.readyState=0;}addEventListener(){}removeEventListener(){}close(){}};
window.fetch=async(url,options={})=>{
  fixture.requests.push({url,method:options.method||'GET',body:options.body||null});
  if(url.startsWith('/api/auth/me'))return json({isAuth:true,user:{id:'u1',username:'owner',roles:['owner']}});
  if(url==='/api/contact-center/outbound-dialer')return json(overview);
  if(url==='/api/contact-center/outbound-dialer/disposition-codes')return json({ok:true,dispositionCodes:[{id:'fixture-disposition',name:'Synthetic mapping',classification:'retry'}],wrapupCodes:[]});
  if(url==='/api/contact-center/outbound-dialer/settings'&&options.method==='PUT'){fixture.saved=JSON.parse(options.body);return json({ok:true,settings:{...settings,...fixture.saved}});}
  if (options.method && options.method !== 'GET') return json({ok:true,contactList:{...lists[0],...JSON.parse(options.body||'{}')}});
  return json({ok:true});
};
createRoot(document.getElementById('root')).render(<div className="flex h-screen min-h-0 flex-col bg-background text-foreground"><OutboundDialerPage/></div>);
