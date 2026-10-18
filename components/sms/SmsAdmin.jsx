"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

import { useCallback,useEffect,useRef,useState } from 'react';
import { Activity,Ban,Brain,Check,LayoutTemplate,Link2,MessageSquare,Phone,Plus,RefreshCw,Save,Trash2,Webhook } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { notify } from '@/components/ToastNotify';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { SectionRail,SECTION_RAIL_PAGE_GRID_CLASS,SECTION_RAIL_WIDTH } from '@/components/ui/section-rail';
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { AdminPageHeader } from '@/components/contact-center/WorkspacePageLayout';
import Link from 'next/link';
import SmsTemplatesSection from './SmsTemplatesSection';
import { smsMessageStatus } from '@/lib/sms/message-status.mjs';

const SMS_SECTIONS=[
  {id:'numbers',label:'Numbers',icon:Phone,description:'Map SMS-capable numbers to Contact Center queues'},
  {id:'profile',label:'Messaging profile',icon:Webhook,description:'Connect the Telnyx messaging profile that delivers webhooks to this application'},
  {id:'templates',label:'Templates',icon:LayoutTemplate,description:'Reusable SMS templates for outbound campaigns'},
  {id:'delivery',label:'Delivery',icon:Activity,description:'Review outbound delivery, opt-outs and inbound processing'},
  {id:'copilot',label:'AI Copilot',icon:Brain,description:'Configure the SMS assistant and knowledge sources'},
];
const rowsOf=result=>Array.isArray(result?.data)?result.data:Array.isArray(result)?result:[];
async function api(params={},body){
  const response=await fetch(`/api/admin/sms${Object.keys(params).length?`?${new URLSearchParams(params)}`:''}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  const result=await response.json();if(!response.ok)throw Error(result.error||'SMS administration unavailable');return result;
}
function Field({label,children}){
  const tUi = useUiText();return <label className="block space-y-1.5 text-xs font-medium">{tUi(label)}{children}</label>;}
function Status({enabled,children}){return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium ${enabled?'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300':'bg-muted text-muted-foreground'}`}>{enabled&&<Check className="size-3"/>}{children}</span>;}
function Loading({label='Loading SMS configuration',rows=3}){
  const tUi = useUiText();
  return <div role="status" aria-label={tUi(label)} className="space-y-4"><span className="sr-only">{tUi(label)}</span>{Array.from({length:rows},(_,i)=><div key={i} className="space-y-2"><Skeleton className="h-4 w-1/3"/><Skeleton className="h-9 w-full"/></div>)}</div>;
}
function DeliveryBadge({row}){
  const tUi = useUiText();
  const {label,tone,title}=smsMessageStatus({sender_role:'agent',delivery:row}, tUi);
  const tones={neutral:'border-border bg-muted/50 text-muted-foreground',info:'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',success:'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',warning:'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',danger:'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300'};
  return <Badge variant="outline" title={tUi(title)} className={tones[tone]}>{tUi(label)}</Badge>;
}
function ResourceTable({rows,columns,action,loading=false}){
  const tUi = useUiText();
  if(loading)return <div className="rounded-xl border p-4"><Loading label={tUi("Loading records")}/></div>;
  return <div className="overflow-auto rounded-xl border"><table className="w-full text-left text-xs"><thead className="bg-muted/50"><tr>{columns.map(([key,label])=><th key={key} className="whitespace-nowrap p-3 font-medium">{tUi(label)}</th>)}{action&&<th className="p-3">{tUi("Actions")}</th>}</tr></thead><tbody>{rows.map((row,i)=><tr key={row.id||row.message_id||row.event_id||row.conversation_id||i} className="border-t">{columns.map(([key,,render])=><td key={key} className="max-w-80 break-words p-3">{render?render(row[key],row):typeof row[key]==='object'&&row[key]!==null?JSON.stringify(row[key]):String(row[key]??'—')}</td>)}{action&&<td className="p-3">{action(row)}</td>}</tr>)}{!rows.length&&<tr><td colSpan={columns.length+Number(Boolean(action))} className="p-6 text-center text-muted-foreground">{tUi("No records to display.")}</td></tr>}</tbody></table></div>;
}
const date=value=>value?new Date(value).toLocaleString():'—';

function NumberEditor({mapping,setMapping,inventory,profiles,queues,busy,onSave}){
  const tUi = useUiText();
  const selected=inventory.find(n=>n.phone_number===mapping.phoneNumber);
  return <form onSubmit={async e=>{e.preventDefault();if(!mapping.phoneNumber||!mapping.queueId||!mapping.profileId){notify({title:'Choose a number, a queue and a messaging profile',variant:'error'});return;}if(await onSave())setMapping(null);}} className="space-y-4 rounded-xl border bg-muted/20 p-4" data-testid="sms-number-editor">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Field label={tUi("Telnyx number")}><Select value={mapping.phoneNumber||undefined} disabled={Boolean(mapping.id)} onValueChange={value=>{const number=inventory.find(n=>n.phone_number===value);setMapping({...mapping,phoneNumber:value,providerNumberId:number?.id||'',countryCode:number?.country_code||'',numberType:number?.type||'',name:mapping.name||number?.phone_number||''});}}>
        <SelectTrigger className="w-full" data-testid="sms-number-choice"><SelectValue placeholder={tUi("Select number")}/></SelectTrigger><SelectContent className="max-h-80">{inventory.map(n=><SelectItem key={n.id} value={n.phone_number} disabled={Boolean(n.managed)&&n.phone_number!==mapping.phoneNumber}>{n.phone_number}{n.sms_capable?'':tUi(" (no SMS)")}{n.managed?tUi(" · mapped"):''}</SelectItem>)}</SelectContent></Select></Field>
      <Field label={tUi("Display name")}><Input required value={mapping.name} onChange={e=>setMapping({...mapping,name:e.target.value})} placeholder={tUi("Sales line")}/></Field>
      <Field label={tUi("Queue")}><Select value={mapping.queueId||undefined} onValueChange={value=>setMapping({...mapping,queueId:value})}><SelectTrigger className="w-full" data-testid="sms-queue-choice"><SelectValue placeholder={tUi("Select queue")}/></SelectTrigger><SelectContent>{queues.map(q=><SelectItem key={q.id} value={q.id}>{q.name}{!q.sms_enabled?tUi(" (enable SMS in Utilization)"):''}</SelectItem>)}</SelectContent></Select></Field>
      <Field label={tUi("Messaging profile")}><SearchableSelect value={mapping.profileId} onChange={value=>setMapping({...mapping,profileId:value})} options={profiles.map(p=>({value:p.id,label:p.name||p.id,description:p.id}))} placeholder={tUi("Select connected profile")} searchPlaceholder={tUi("Filter profiles…")} emptyText={tUi("No connected profile matches.")} data-testid="sms-profile-choice"/></Field>
    </div>
    {selected&&selected.messaging_profile_id&&mapping.profileId&&selected.messaging_profile_id!==mapping.profileId&&<p className="text-xs text-amber-700 dark:text-amber-300">{tUi("Saving moves this number from messaging profile ")}<code>{selected.messaging_profile_id}</code>{tUi(" to the selected Contact Center profile in Telnyx.")}</p>}
    {selected&&!selected.sms_capable&&<p className="text-xs text-destructive">{tUi("Telnyx reports no SMS features for this number.")}</p>}
    <div className="flex flex-wrap gap-6"><label className="flex items-center gap-2 text-xs"><Switch checked={mapping.routingEnabled} onCheckedChange={v=>setMapping({...mapping,routingEnabled:v})}/>{tUi("Route incoming SMS to the queue")}</label><label className="flex items-center gap-2 text-xs"><Switch checked={mapping.sendingEnabled} onCheckedChange={v=>setMapping({...mapping,sendingEnabled:v})}/>{tUi("Allow agent replies")}</label></div>
    <div className="flex gap-2"><Button size="sm" disabled={busy}><Save className="mr-1 size-3.5"/>{tUi("Save number")}</Button><Button type="button" size="sm" variant="ghost" onClick={()=>setMapping(null)}>{tUi("Cancel")}</Button></div>
  </form>;
}

const sectionFromLocation=()=>{try{const value=new URLSearchParams(window.location.search).get('section');return SMS_SECTIONS.some(section=>section.id===value)?value:null;}catch{return null;}};

export default function SmsAdmin({initialSection='numbers'}){
  const tUi = useUiText();
  const [tab,setTab]=useState(()=>SMS_SECTIONS.some(section=>section.id===initialSection)?initialSection:'numbers'),[overview,setOverview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{const fromQuery=sectionFromLocation();if(fromQuery)setTab(fromQuery);},[]);
  const [inventory,setInventory]=useState([]),[profiles,setProfiles]=useState([]),[inventoryError,setInventoryError]=useState('');
  const [mapping,setMapping]=useState(null),[profileChoice,setProfileChoice]=useState(''),[newProfileName,setNewProfileName]=useState('Contact Center');
  const [deliveries,setDeliveries]=useState([]),[optOuts,setOptOuts]=useState([]),[copilot,setCopilot]=useState(null);
  const [overviewLoading,setOverviewLoading]=useState(true),[inventoryLoading,setInventoryLoading]=useState(true),[resourceLoading,setResourceLoading]=useState(false);
  const refreshRevision=useRef(0),loadRevision=useRef(0);
  const [resourceRevision,setResourceRevision]=useState(0),[copilotRevision,setCopilotRevision]=useState(0);
  const refresh=useCallback(async()=>{
    const revision=++refreshRevision.current;setOverviewLoading(true);setInventoryLoading(true);
    try{
      const [summary,numbers,profileList]=await Promise.allSettled([api(),api({resource:'numbers'}),api({resource:'profiles'})]);
      if(revision!==refreshRevision.current)return;
      if(summary.status==='fulfilled'){setOverview(summary.value);setCopilot(current=>current||summary.value.copilot);}
      if(numbers.status==='fulfilled')setInventory(rowsOf(numbers.value));
      if(profileList.status==='fulfilled')setProfiles(rowsOf(profileList.value));
      setInventoryError([numbers,profileList].filter(r=>r.status==='rejected').map(r=>r.reason.message).join(' · '));
      if(summary.status==='rejected')throw summary.reason;
    }finally{if(revision===refreshRevision.current){setOverviewLoading(false);setInventoryLoading(false);}}
  },[]);
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[refresh]);
  const loadTab=useCallback(async()=>{
    const revision=++loadRevision.current;setError('');
    if(tab!=='delivery')return;
    setResourceLoading(true);
    try{
      const [sent,blocked]=await Promise.all([api({resource:'deliveries'}),api({resource:'opt-outs'})]);
      if(revision!==loadRevision.current)return;
      setDeliveries(rowsOf(sent));setOptOuts(rowsOf(blocked));
    }catch(error){if(revision===loadRevision.current)throw error;}
    finally{if(revision===loadRevision.current)setResourceLoading(false);}
  },[tab]);
  useEffect(()=>{void loadTab().catch(e=>setError(e.message));},[loadTab,resourceRevision]);
  async function action(body){
    setBusy(true);setError('');
    try{
      const result=await api({},body);
      notify({title:body.action==='retry_ingestion'?'Message retry requested':'Changes saved',description:result.warning,variant:result.warning?'warning':'success'});
      await refresh().catch(e=>notify({title:'Changes saved, but refresh failed',description:e.message,variant:'warning'}));
      setResourceRevision(revision=>revision+1);return result;
    }catch(e){notify({title:'SMS action failed',description:e.message,variant:'error'});return null;}finally{setBusy(false);}
  }
  async function refreshAll(){setBusy(true);setCopilotRevision(revision=>revision+1);try{await refresh();setResourceRevision(revision=>revision+1);}catch(e){setError(e.message);}finally{setBusy(false);}}
  const connectedProfiles=overview?.profiles||[];
  const activeSection=SMS_SECTIONS.find(section=>section.id===tab);
  const editor=mapping&&<NumberEditor mapping={mapping} setMapping={setMapping} inventory={inventory} profiles={connectedProfiles} queues={overview?.queues||[]} busy={busy||inventoryLoading} onSave={()=>action({action:'save_number',...mapping})}/>;
  return <><AdminPageHeader title={tUi("SMS")} actions={<Button size="sm" variant="outline" disabled={busy} onClick={refreshAll}><RefreshCw className="mr-2 size-3.5"/>{tUi("Refresh")}</Button>}/><main className={`${SECTION_RAIL_PAGE_GRID_CLASS} overflow-hidden`} style={{gridTemplateColumns:`${SECTION_RAIL_WIDTH} minmax(0,1fr)`}} data-testid="sms-admin">
    <SectionRail items={SMS_SECTIONS} activeId={tab} onSelect={setTab} ariaLabel={tUi("SMS administration sections")} screenGroup="admin.sms"/>
    <section aria-label={tUi("{value0} configuration", { value0: activeSection.label })} className="flex min-h-0 min-w-0 flex-col overflow-hidden" data-testid="sms-admin-content">
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1 pb-4">
      {(error||inventoryError)&&<p role="alert" className="shrink-0 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{error||inventoryError}</p>}
      {overviewLoading&&!overview?<Card><CardContent className="p-6"><Loading label={tUi("Loading {value0}", { value0: activeSection.label })} rows={5}/></CardContent></Card>:<>
      {tab==='numbers'&&<>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[['Mapped numbers',overview?.numbers.length||0],['Routing enabled',overview?.numbers.filter(n=>n.routing_enabled).length||0],['Awaiting routing',overview?.numbers.reduce((n,row)=>n+row.backlog,0)||0],['Opted-out customers',overview?.numbers.reduce((n,row)=>n+row.opted_out,0)||0]].map(([label,value])=><Card key={label}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{tUi(label)}</p><div className="mt-2 text-2xl font-semibold">{overview?value:'—'}</div></CardContent></Card>)}</div>
        {!connectedProfiles.length&&!overviewLoading&&<div className="rounded-xl border border-dashed p-6 text-center"><Webhook className="mx-auto mb-3 size-8 text-sky-400"/><p className="text-sm font-medium">{tUi("Connect a messaging profile first")}</p><p className="mt-1 text-xs text-muted-foreground">{tUi("Inbound SMS reaches Contact Center only through a messaging profile whose webhook points at this application.")}</p><Button size="sm" className="mt-3" variant="outline" onClick={()=>setTab('profile')}>{tUi("Open Messaging profile")}</Button></div>}
        <Card><CardHeader className="flex flex-row items-center justify-between"><div><CardTitle>{tUi("Queue numbers")}</CardTitle><p className="mt-1 text-xs text-muted-foreground">{tUi("Each number routes to one queue. Pause routing or agent replies independently.")}</p></div><Button size="sm" disabled={!connectedProfiles.length} onClick={()=>setMapping({phoneNumber:'',providerNumberId:'',name:'',queueId:'',profileId:connectedProfiles[0]?.id||'',routingEnabled:false,sendingEnabled:false})}><Plus className="mr-1 size-4"/>{tUi("Map number")}</Button></CardHeader><CardContent className="space-y-4">
          {overviewLoading?<Loading label={tUi("Loading queue numbers")}/>:overview?.numbers.map(number=><div key={number.id} data-testid="sms-queue-number" className="rounded-xl border p-4"><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="flex items-center gap-2 text-sm font-semibold"><MessageSquare className="size-4 text-sky-500"/>{number.name}</div><p className="mt-1 text-xs text-muted-foreground">{number.phone_number} → {number.queue_name}{!number.queue_sms_enabled&&<span className="ml-2 text-amber-700 dark:text-amber-300">{tUi("SMS disabled on this queue")}</span>}</p><p className="mt-2 text-[10px] text-muted-foreground">{number.profile_name?tUi("Profile: {value0}", { value0: number.profile_name }):tUi("No messaging profile")} · {number.threads}{tUi(" conversations · ")}{number.backlog}{tUi(" awaiting routing · ")}{number.opted_out}{tUi(" opted out")}{number.last_inbound_at?tUi(" · Last inbound {value0}", { value0: date(number.last_inbound_at) }):''}</p>{number.last_error&&<p className="mt-2 text-xs text-destructive">{number.last_error}</p>}</div><div className="flex items-center gap-2"><Status enabled={number.routing_enabled}>{number.routing_enabled?tUi("Routing"):tUi("Routing paused")}</Status><Status enabled={number.sending_enabled}>{number.sending_enabled?tUi("Sending"):tUi("Sending paused")}</Status><Button size="sm" variant="outline" onClick={()=>setMapping({id:number.id,version:number.version,phoneNumber:number.phone_number,providerNumberId:number.provider_number_id||'',name:number.name,queueId:number.queue_id,profileId:number.messaging_profile_id||'',routingEnabled:number.routing_enabled,sendingEnabled:number.sending_enabled,countryCode:number.country_code||'',numberType:number.number_type||''})}>{tUi("Configure")}</Button>{!number.threads&&<Button size="sm" variant="ghost" aria-label={tUi("Remove {value0}", { value0: number.phone_number })} disabled={busy} onClick={()=>{if(window.confirm(tUi("Remove this number mapping? The number stays in your Telnyx account.")))void action({action:'remove_number',id:number.id});}}><Trash2 className="size-4"/></Button>}</div></div>{mapping?.id===number.id&&<div className="mt-4">{editor}</div>}</div>)}
          {!overviewLoading&&overview&&!overview.numbers.length&&<div className="rounded-xl border border-dashed p-8 text-center"><Phone className="mx-auto mb-3 size-8 text-sky-400"/><p className="text-sm font-medium">{tUi("Map your first number")}</p><p className="mt-1 text-xs text-muted-foreground">{tUi("Choose an SMS-capable number from your Telnyx account, assign it to the Contact Center messaging profile and pick the queue it serves.")}</p></div>}
          {mapping&&!mapping.id&&editor}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{tUi("Telnyx number inventory")}</CardTitle><p className="text-xs text-muted-foreground">{tUi("Numbers with messaging settings in the connected account. A number belongs to exactly one messaging profile.")}</p></CardHeader><CardContent>{inventoryLoading?<Loading label={tUi("Loading Telnyx numbers")}/>:<ResourceTable rows={inventory} columns={[[ 'phone_number','Number'],['type','Type'],['country_code','Country'],['messaging_profile_id','Messaging profile',(value)=>{const profile=connectedProfiles.find(p=>p.id===value);return profile?<Badge variant="outline" className="border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300">{profile.name||profile.id}</Badge>:value||tUi('Unassigned');}],['sms_capable','SMS',(value,row)=>value?<Status enabled>{row.two_way?tUi("Two-way"):tUi("Enabled")}</Status>:<Status>{tUi("Not enabled")}</Status>],['managed','Contact Center',value=>value?<Status enabled>{tUi("Mapped")}</Status>:'—']]}/>}</CardContent></Card>
      </>}
      {tab==='profile'&&<>
        <Card><CardHeader><CardTitle>{tUi("Webhook destination")}</CardTitle><p className="text-xs text-muted-foreground">{tUi("Telnyx delivers ")}<code>message.received</code>, <code>message.sent</code>{tUi(" and ")}<code>message.finalized</code>{tUi(" for every number on a connected profile to this signed endpoint.")}</p></CardHeader><CardContent className="space-y-3 text-xs">
          <div className="grid gap-3 sm:grid-cols-2"><div><p className="text-muted-foreground">{tUi("Webhook URL")}</p><p className="mt-1 break-all font-mono" data-testid="sms-webhook-url">{overview?.webhookUrl||overview?.webhookError||overview?.webhookPath}</p></div><div className="space-y-2"><p className="text-muted-foreground">{tUi("Server configuration")}</p><div className="flex flex-wrap gap-2"><Status enabled={overview?.credentialsConfigured}>{overview?.credentialsConfigured?tUi("API key configured"):tUi("API key missing")}</Status><Status enabled={overview?.webhookKeyConfigured}>{overview?.webhookKeyConfigured?tUi("Signature key configured"):tUi("Signature key missing")}</Status></div></div></div>
          {overview?.webhookError&&<p role="alert" className="text-destructive">{overview.webhookError}</p>}
          <p className="leading-relaxed text-muted-foreground">{tUi("Recommended setup is one Contact Center messaging profile that carries every managed number. Routing uses the receiving number, so separate profiles per queue only add configuration to keep in sync. Keep Number Pool disabled on connected profiles: agent replies must leave from the queue number the customer texted.")}</p>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>{tUi("Connected profiles")}</CardTitle></CardHeader><CardContent className="space-y-4">
          {connectedProfiles.map(profile=><div key={profile.id} data-testid="sms-profile" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"><div><div className="flex items-center gap-2 text-sm font-semibold"><Link2 className="size-4 text-sky-500"/>{profile.name||profile.id}</div><p className="mt-1 break-all text-xs text-muted-foreground">{profile.id} · {tUi("Mapped numbers: {value0}", {value0: profile.number_count})}</p><p className="mt-1 break-all text-[10px] text-muted-foreground">{profile.webhook_url||tUi("No webhook URL")}{profile.webhook_api_version?tUi(" · API v{value0}", { value0: profile.webhook_api_version }):''}</p>{profile.last_error&&<p className="mt-2 text-xs text-destructive">{profile.last_error}</p>}</div><div className="flex items-center gap-2"><Status enabled={Boolean(profile.webhook_verified_at)&&profile.webhook_url===overview?.webhookUrl}>{profile.webhook_verified_at&&profile.webhook_url===overview?.webhookUrl?tUi("Webhook verified {value0}", { value0: date(profile.webhook_verified_at) }):tUi("Webhook needs verification")}</Status><Button size="sm" variant="outline" disabled={busy} onClick={()=>action({action:'connect_profile',profileId:profile.id})}>{tUi("Verify webhook")}</Button>{!profile.number_count&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>{if(window.confirm(tUi("Disconnect this profile from Contact Center? It is not deleted in Telnyx.")))void action({action:'disconnect_profile',profileId:profile.id});}}>{tUi("Disconnect")}</Button>}</div></div>)}
          {!connectedProfiles.length&&<p className="py-4 text-center text-sm text-muted-foreground">{tUi("No messaging profile connected yet.")}</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <form className="space-y-3 rounded-xl border bg-muted/20 p-4" onSubmit={e=>{e.preventDefault();void action({action:'connect_profile',profileId:profileChoice});}}><p className="text-sm font-medium">{tUi("Connect an existing profile")}</p><Field label={tUi("Telnyx messaging profile")}><SearchableSelect value={profileChoice} onChange={setProfileChoice} disabled={inventoryLoading} options={profiles.map(p=>({value:p.id,label:p.name||p.id,description:[p.connected?'connected':null,p.number_pool?'number pool':null].filter(Boolean).join(' · ')||p.id}))} placeholder={tUi("Select profile")} searchPlaceholder={tUi("Filter profiles by name…")} emptyText={tUi("No messaging profile matches.")} data-testid="sms-profile-picker"/></Field><p className="text-[10px] text-muted-foreground">{tUi("Connecting sets the webhook URL and API version 2 on the profile. Other destinations and settings are not changed.")}</p><Button size="sm" disabled={busy||!profileChoice}><Link2 className="mr-1 size-3.5"/>{tUi("Connect profile")}</Button></form>
            <form className="space-y-3 rounded-xl border bg-muted/20 p-4" onSubmit={e=>{e.preventDefault();void action({action:'connect_profile',create:true,name:newProfileName});}}><p className="text-sm font-medium">{tUi("Create a Contact Center profile")}</p><Field label={tUi("Profile name")}><Input required value={newProfileName} onChange={e=>setNewProfileName(e.target.value)}/></Field><p className="text-[10px] text-muted-foreground">{tUi("Creates a new profile in Telnyx with the webhook already configured and all destinations allowed.")}</p><Button size="sm" variant="outline" disabled={busy||!newProfileName.trim()}><Plus className="mr-1 size-3.5"/>{tUi("Create and connect")}</Button></form>
          </div>
        </CardContent></Card>
      </>}
      {tab==='templates'&&<SmsTemplatesSection busy={busy} setBusy={setBusy} footerPolicy={overview?.footerPolicy}/>}
      {tab==='delivery'&&<>
        <Card><CardHeader><CardTitle>{tUi("Outbound delivery")}</CardTitle><p className="text-xs text-muted-foreground">{tUi("Sent means Telnyx handed the message to the carrier. Delivered means the carrier confirmed the handset, not that the customer read it.")}</p></CardHeader><CardContent><ResourceTable loading={resourceLoading} rows={deliveries} columns={[[ 'created_at','Sent',value=>date(value)],['business_number','From'],['customer_address','To'],['agent','Agent'],['text','Message'],['status','Status',(value,row)=><DeliveryBadge row={row}/>],['encoding','Encoding',(value,row)=>value?`${value} · ${row.parts||1} part${row.parts===1?'':'s'}`:'—'],['error_detail','Provider error',(value,row)=>value?`${row.error_code?`${row.error_code} · `:''}${value}`:'—']]}/></CardContent></Card>
        <Card><CardHeader><CardTitle>{tUi("Opted-out customers")}</CardTitle><p className="text-xs text-muted-foreground">{tUi("Customers who texted STOP. Agent replies stay blocked until the customer texts START; Telnyx applies its own carrier keyword handling.")}</p></CardHeader><CardContent><ResourceTable loading={resourceLoading} rows={optOuts} columns={[[ 'customer_address','Customer'],['business_number','Number',(value,row)=>row.number_name?`${row.number_name} · ${value}`:value],['opted_out_at','Opted out',value=>date(value)],['last_inbound_at','Last message',value=>date(value)]]}/></CardContent></Card>
        <Card><CardHeader><CardTitle>{tUi("Inbound processing")}</CardTitle><p className="text-xs text-muted-foreground">{tUi("Unmatched events arrived for numbers that are not mapped. Failed events did not reach the queue; resolve the error and retry.")}</p></CardHeader><CardContent className="space-y-4"><ResourceTable loading={overviewLoading} rows={overview?.ingestionFailures||[]} columns={[[ 'received_at','Received',value=>date(value)],['event_type','Event'],['from_number','From'],['to_number','To'],['text','Text'],['status','Status',value=><Badge variant="outline" className={value==='dead'?'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300':'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-300'}>{value==='dead'?tUi("Failed"):value==='unmatched'?tUi("Unmatched"):tUi("Retrying")}</Badge>],['last_error','Error']]} action={row=>row.status!=='unmatched'&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>action({action:'retry_ingestion',eventId:row.event_id,requestId:crypto.randomUUID()})}>{tUi("Retry")}</Button>}/><ResourceTable loading={overviewLoading} rows={overview?.audit||[]} columns={[[ 'created_at','Time',value=>date(value)],['action','Admin action'],['resource_id','Resource'],['actor_name','Administrator']]}/></CardContent></Card>
      </>}
      {tab==='copilot'&&<Card><CardHeader><CardTitle>{tUi("AI Copilot")}</CardTitle></CardHeader><CardContent><p className="mb-4 text-sm text-muted-foreground">{tUi("Models, instructions and channel knowledge sources are managed in System Settings.")}</p><Button asChild><Link href="/admin/system/settings/ai-copilot">{tUi("Open AI Copilot settings")}</Link></Button></CardContent></Card>}
    </>}
    </div>
    </section>
  </main></>;
}
