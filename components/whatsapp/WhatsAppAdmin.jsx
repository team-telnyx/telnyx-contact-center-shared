"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import { Activity,Brain,Building2,CheckCircle2,CircleOff,KeyRound,LayoutTemplate,Link2,Phone,Plus,RefreshCw,Save,Smartphone,Trash2,Webhook } from 'lucide-react';
import { IconBrandWhatsapp } from '@tabler/icons-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { notify } from '@/components/ToastNotify';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { SectionRail,SECTION_RAIL_PAGE_GRID_CLASS,SECTION_RAIL_WIDTH } from '@/components/ui/section-rail';
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@/components/ui/select';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { AdminPageHeader } from '@/components/contact-center/WorkspacePageLayout';
import ChatCopilotSettings from '@/components/admin/ChatCopilotSettings';
import WhatsAppTemplatesSection from './WhatsAppTemplatesSection';
import WhatsAppPhoneNumbersSection from './WhatsAppPhoneNumbersSection';
import { api,rowsOf,date,humanize,Field,Status,StatusBadge,Loading,ResourceTable,DeliveryBadge,CopyValue } from './whatsapp-admin-shared';
import { WHATSAPP_WABA_WEBHOOK_EVENTS,WHATSAPP_TIMEZONES,whatsappReadinessItems } from '@/lib/whatsapp/admin-model.mjs';

const SECTIONS=[
  {id:'numbers',label:'Numbers',icon:Phone,description:'Map WhatsApp numbers to Contact Center queues'},
  {id:'details',label:'Details',icon:Building2,description:'WhatsApp Business Account, Telnyx credentials, webhook and messaging profile'},
  {id:'templates',label:'Templates',icon:LayoutTemplate,description:'Message templates reviewed by Meta'},
  {id:'phone-numbers',label:'Phone numbers',icon:Smartphone,description:'Business profiles, verification and WhatsApp calling'},
  {id:'delivery',label:'Delivery',icon:Activity,description:'Outbound delivery, inbound processing and audit'},
  {id:'copilot',label:'AI Copilot',icon:Brain,description:'Configure the WhatsApp assistant and knowledge sources'},
];

function NumberEditor({mapping,setMapping,inventory,profiles,queues,busy,onSave}){
  const chosen=inventory.find(n=>n.phoneNumber===mapping.phoneNumber);
  return <form onSubmit={async e=>{e.preventDefault();if(!mapping.phoneNumber||!mapping.queueId||!mapping.profileId){notify({title:'Choose a number, a queue and a messaging profile',variant:'error'});return;}if(await onSave())setMapping(null);}} className="space-y-4 rounded-xl border bg-muted/20 p-4" data-testid="whatsapp-number-editor">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Field label="WhatsApp number"><Select value={mapping.phoneNumber||undefined} disabled={Boolean(mapping.id)} onValueChange={value=>{const number=inventory.find(n=>n.phoneNumber===value);setMapping({...mapping,phoneNumber:value,phoneNumberId:number?.phoneNumberId||'',wabaId:number?.wabaId||'',displayName:number?.displayName||'',qualityRating:number?.qualityRating||'',providerStatus:number?.status||'',name:mapping.name||number?.displayName||number?.phoneNumber||''});}}>
        <SelectTrigger className="w-full" data-testid="whatsapp-number-choice"><SelectValue placeholder="Select number"/></SelectTrigger><SelectContent className="max-h-80">{inventory.map(n=><SelectItem key={n.phoneNumber} value={n.phoneNumber} disabled={Boolean(n.managed)&&n.phoneNumber!==mapping.phoneNumber} textValue={`${n.phoneNumber} ${n.displayName}`}>{n.phoneNumber} · {n.displayName}{String(n.status).toUpperCase()!=='CONNECTED'?` (${humanize(n.status)})`:''}{n.managed?' · mapped':''}</SelectItem>)}</SelectContent></Select></Field>
      <Field label="Display name"><Input required value={mapping.name} onChange={e=>setMapping({...mapping,name:e.target.value})} placeholder="Support WhatsApp"/></Field>
      <Field label="Queue"><Select value={mapping.queueId||undefined} onValueChange={value=>setMapping({...mapping,queueId:value})}><SelectTrigger className="w-full" data-testid="whatsapp-queue-choice"><SelectValue placeholder="Select queue"/></SelectTrigger><SelectContent>{queues.map(q=><SelectItem key={q.id} value={q.id}>{q.name}{!q.whatsapp_enabled?' (enable WhatsApp in Utilization)':''}</SelectItem>)}</SelectContent></Select></Field>
      <Field label="Messaging profile"><SearchableSelect value={mapping.profileId} onChange={value=>setMapping({...mapping,profileId:value})} options={profiles.map(p=>({value:p.id,label:p.name||p.id,description:p.id}))} placeholder="Select connected profile" searchPlaceholder="Filter profiles…" emptyText="No connected profile matches." data-testid="whatsapp-profile-choice"/></Field>
    </div>
    <p className="text-xs text-muted-foreground">Saving points inbound messages for this number at the selected Contact Center messaging profile in Telnyx. Numbers left on another profile (for example a demo portal) keep working there.</p>
    {chosen&&String(chosen.status).toUpperCase()!=='CONNECTED'&&<p className="text-xs text-amber-700 dark:text-amber-300">Telnyx reports this number as {humanize(chosen.status)}. Finish verification under Phone numbers before routing.</p>}
    <div className="flex flex-wrap gap-6"><label className="flex items-center gap-2 text-xs"><Switch checked={mapping.routingEnabled} onCheckedChange={v=>setMapping({...mapping,routingEnabled:v})}/>Route incoming WhatsApp to the queue</label><label className="flex items-center gap-2 text-xs"><Switch checked={mapping.sendingEnabled} onCheckedChange={v=>setMapping({...mapping,sendingEnabled:v})}/>Allow agent replies</label></div>
    <div className="flex gap-2"><Button size="sm" disabled={busy}><Save className="mr-1 size-3.5"/>Save number</Button><Button type="button" size="sm" variant="ghost" onClick={()=>setMapping(null)}>Cancel</Button></div>
  </form>;
}

function AccountSettingsForm({account,settings,busy,onSave}){
  const [form,setForm]=useState(settings);
  useEffect(()=>{setForm(settings);},[settings]);
  if(!form)return null;
  const patch=value=>setForm(current=>({...current,...value}));
  const toggleEvent=(event,checked)=>patch({webhookEvents:checked?[...new Set([...(form.webhookEvents||[]),event])]:(form.webhookEvents||[]).filter(e=>e!==event)});
  return <Card><CardHeader><CardTitle>WABA settings</CardTitle><p className="text-xs text-muted-foreground">Integration-level notifications about the WhatsApp Business Account. Message delivery and inbound messages use the messaging profile webhook instead.</p></CardHeader><CardContent className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2"><Field label="Account name"><Input value={form.name||''} onChange={e=>patch({name:e.target.value})}/></Field>
      <Field label="Timezone"><Select value={form.timezone||'UTC'} onValueChange={value=>patch({timezone:value})}><SelectTrigger className="w-full" data-testid="whatsapp-timezone"><SelectValue/></SelectTrigger><SelectContent className="max-h-80">{[...new Set([form.timezone||'UTC',...WHATSAPP_TIMEZONES])].map(tz=><SelectItem key={tz} value={tz}>{tz}</SelectItem>)}</SelectContent></Select></Field></div>
    <label className="flex items-center justify-between gap-3 rounded-xl border p-3 text-xs"><span><span className="font-medium">Receive WABA events</span><span className="block text-[10px] text-muted-foreground">Telnyx delivers the selected account events in real time.</span></span><Switch checked={Boolean(form.webhookEnabled)} onCheckedChange={v=>patch({webhookEnabled:v})}/></label>
    <div className="grid gap-3 sm:grid-cols-2"><Field label="Webhook URL"><Input value={form.webhookUrl||''} onChange={e=>patch({webhookUrl:e.target.value})} placeholder="https://example.com/api/webhooks/whatsapp/account"/></Field><Field label="Failover URL"><Input value={form.webhookFailoverUrl||''} onChange={e=>patch({webhookFailoverUrl:e.target.value})} placeholder="https://backup.example.com/webhooks/whatsapp"/></Field></div>
    <div className="space-y-2"><p className="text-xs font-medium">Event subscriptions</p><div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{WHATSAPP_WABA_WEBHOOK_EVENTS.map(event=><label key={event.value} className="flex cursor-pointer items-center gap-2 rounded-lg border p-2 text-xs hover:bg-muted/40"><Checkbox checked={(form.webhookEvents||[]).includes(event.value)} onCheckedChange={v=>toggleEvent(event.value,v===true)}/>{event.label}</label>)}</div></div>
    <div className="flex justify-end"><Button size="sm" disabled={busy} onClick={()=>void onSave(form)}><Save className="mr-1 size-3.5"/>Save settings</Button></div>
  </CardContent></Card>;
}

export default function WhatsAppAdmin(){
  const [tab,setTab]=useState('numbers'),[overview,setOverview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [inventory,setInventory]=useState([]),[profiles,setProfiles]=useState([]),[accounts,setAccounts]=useState([]),[inventoryError,setInventoryError]=useState('');
  const [accountId,setAccountId]=useState(''),[accountDetail,setAccountDetail]=useState(null),[accountLoading,setAccountLoading]=useState(false);
  const [mapping,setMapping]=useState(null),[profileChoice,setProfileChoice]=useState(''),[newProfileName,setNewProfileName]=useState('Contact Center WhatsApp');
  const [deliveries,setDeliveries]=useState([]),[copilot,setCopilot]=useState(null);
  const [overviewLoading,setOverviewLoading]=useState(true),[inventoryLoading,setInventoryLoading]=useState(true),[resourceLoading,setResourceLoading]=useState(false);
  const refreshRevision=useRef(0),accountRevision=useRef(0);
  const [resourceRevision,setResourceRevision]=useState(0),[copilotRevision,setCopilotRevision]=useState(0);
  const refresh=useCallback(async()=>{
    const revision=++refreshRevision.current;setOverviewLoading(true);setInventoryLoading(true);
    try{
      const [summary,numbers,profileList,accountList]=await Promise.allSettled([api(),api({resource:'phone-numbers'}),api({resource:'profiles'}),api({resource:'accounts'})]);
      if(revision!==refreshRevision.current)return;
      if(summary.status==='fulfilled'){setOverview(summary.value);setCopilot(current=>current||summary.value.copilot);setAccountId(current=>current||summary.value.accounts?.[0]?.id||'');}
      if(numbers.status==='fulfilled')setInventory(rowsOf(numbers.value));
      if(profileList.status==='fulfilled')setProfiles(rowsOf(profileList.value));
      // Without a connected account, prefer the WABA that actually carries numbers.
      if(accountList.status==='fulfilled'){const list=rowsOf(accountList.value);setAccounts(list);setAccountId(current=>current||(list.find(a=>a.connected)||[...list].sort((a,b)=>(b.phoneNumbersCount||0)-(a.phoneNumbersCount||0))[0])?.id||'');}
      setInventoryError([numbers,profileList,accountList].filter(r=>r.status==='rejected').map(r=>r.reason.message).join(' · '));
      if(summary.status==='rejected')throw summary.reason;
    }finally{if(revision===refreshRevision.current){setOverviewLoading(false);setInventoryLoading(false);}}
  },[]);
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[refresh]);
  const loadAccount=useCallback(async()=>{
    const revision=++accountRevision.current;
    if(!accountId){setAccountDetail(null);return;}
    setAccountLoading(true);
    try{const detail=await api({resource:'account',id:accountId});if(revision===accountRevision.current)setAccountDetail(detail);}
    catch(e){if(revision===accountRevision.current){setAccountDetail(null);setError(e.message);}}
    finally{if(revision===accountRevision.current)setAccountLoading(false);}
  },[accountId]);
  useEffect(()=>{void loadAccount();},[loadAccount,resourceRevision]);
  useEffect(()=>{
    if(tab!=='delivery')return;
    let cancelled=false;setResourceLoading(true);
    api({resource:'deliveries'}).then(result=>{if(!cancelled)setDeliveries(rowsOf(result));}).catch(e=>{if(!cancelled)setError(e.message);}).finally(()=>{if(!cancelled)setResourceLoading(false);});
    return()=>{cancelled=true;};
  },[tab,resourceRevision]);
  async function action(body,title='Changes saved'){
    setBusy(true);setError('');
    try{
      const result=await api({},body);
      notify({title,description:result.warning,variant:result.warning?'warning':'success'});
      await refresh().catch(e=>notify({title:'Changes saved, but refresh failed',description:e.message,variant:'warning'}));
      setResourceRevision(revision=>revision+1);return result;
    }catch(e){notify({title:'WhatsApp action failed',description:e.message,variant:'error'});return null;}finally{setBusy(false);}
  }
  async function refreshAll(){setBusy(true);setCopilotRevision(revision=>revision+1);try{await refresh();setResourceRevision(revision=>revision+1);}catch(e){setError(e.message);}finally{setBusy(false);}}
  const connectedProfiles=overview?.profiles||[];
  const connectedAccount=overview?.accounts?.find(a=>a.id===accountId)||null;
  const activeSection=SECTIONS.find(section=>section.id===tab);
  const credentials=overview?.credentials;
  const editor=mapping&&<NumberEditor mapping={mapping} setMapping={setMapping} inventory={inventory} profiles={connectedProfiles} queues={overview?.queues||[]} busy={busy||inventoryLoading} onSave={()=>action({action:'save_number',...mapping})}/>;
  const scopedNumbers=accountDetail?.phoneNumbers?.length?accountDetail.phoneNumbers.map(n=>({...n,managed:inventory.find(i=>i.phoneNumber===n.phoneNumber)?.managed||null})):inventory;
  return <><AdminPageHeader title="WhatsApp" actions={<Button size="sm" variant="outline" disabled={busy} onClick={refreshAll}><RefreshCw className="mr-2 size-3.5"/>Refresh</Button>}/><main className={`${SECTION_RAIL_PAGE_GRID_CLASS} overflow-hidden`} style={{gridTemplateColumns:`${SECTION_RAIL_WIDTH} minmax(0,1fr)`}} data-testid="whatsapp-admin">
    <SectionRail items={SECTIONS} activeId={tab} onSelect={setTab} ariaLabel="WhatsApp administration sections" screenGroup="admin.whatsapp"/>
    <section aria-label={`${activeSection.label} configuration`} className="flex min-h-0 min-w-0 flex-col overflow-hidden" data-testid="whatsapp-admin-content">
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1 pb-4">
      {(error||inventoryError)&&<p role="alert" className="shrink-0 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{error||inventoryError}</p>}
      {overviewLoading&&!overview?<Card><CardContent className="p-6"><Loading label={`Loading ${activeSection.label}`} rows={5}/></CardContent></Card>:<>
      {tab==='numbers'&&<>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[['Mapped numbers',overview?.numbers.length||0],['Routing enabled',overview?.numbers.filter(n=>n.routing_enabled).length||0],['Awaiting routing',overview?.numbers.reduce((n,row)=>n+row.backlog,0)||0],['Open 24h windows',overview?.numbers.reduce((n,row)=>n+row.open_windows,0)||0]].map(([label,value])=><Card key={label}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{label}</p><div className="mt-2 text-2xl font-semibold">{overview?value:'—'}</div></CardContent></Card>)}</div>
        {!connectedProfiles.length&&!overviewLoading&&<div className="rounded-xl border border-dashed p-6 text-center"><Webhook className="mx-auto mb-3 size-8 text-green-600"/><p className="text-sm font-medium">Connect a messaging profile first</p><p className="mt-1 text-xs text-muted-foreground">Inbound WhatsApp messages reach Contact Center only through a messaging profile whose webhook points at this application.</p><Button size="sm" className="mt-3" variant="outline" onClick={()=>setTab('details')}>Open Details</Button></div>}
        <Card><CardHeader className="flex flex-row items-center justify-between"><div><CardTitle>Queue numbers</CardTitle><p className="mt-1 text-xs text-muted-foreground">Each WhatsApp number routes to one queue. Pause routing or agent replies independently.</p></div><Button size="sm" disabled={!connectedProfiles.length} onClick={()=>setMapping({phoneNumber:'',phoneNumberId:'',wabaId:'',displayName:'',name:'',queueId:'',profileId:connectedProfiles[0]?.id||'',routingEnabled:false,sendingEnabled:false})}><Plus className="mr-1 size-4"/>Map number</Button></CardHeader><CardContent className="space-y-4">
          {overviewLoading?<Loading label="Loading queue numbers"/>:overview?.numbers.map(number=><div key={number.id} data-testid="whatsapp-queue-number" className="rounded-xl border p-4"><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="flex items-center gap-2 text-sm font-semibold"><IconBrandWhatsapp className="size-4 text-green-600"/>{number.name}</div><p className="mt-1 text-xs text-muted-foreground">{number.phone_number}{number.display_name?` (${number.display_name})`:''} → {number.queue_name}{!number.queue_whatsapp_enabled&&<span className="ml-2 text-amber-700 dark:text-amber-300">WhatsApp disabled on this queue</span>}</p><p className="mt-2 text-[10px] text-muted-foreground">{number.profile_name?`Profile: ${number.profile_name}`:'No messaging profile'} · {number.threads} conversations · {number.backlog} awaiting routing · {number.open_windows} open windows{number.last_inbound_at?` · Last inbound ${date(number.last_inbound_at)}`:''}</p>{number.last_error&&<p className="mt-2 text-xs text-destructive">{number.last_error}</p>}</div><div className="flex items-center gap-2"><Status enabled={number.routing_enabled}>{number.routing_enabled?'Routing':'Routing paused'}</Status><Status enabled={number.sending_enabled}>{number.sending_enabled?'Sending':'Sending paused'}</Status><Button size="sm" variant="outline" onClick={()=>setMapping({id:number.id,version:number.version,phoneNumber:number.phone_number,phoneNumberId:number.phone_number_id||'',wabaId:number.waba_id||'',displayName:number.display_name||'',name:number.name,queueId:number.queue_id,profileId:number.messaging_profile_id||'',routingEnabled:number.routing_enabled,sendingEnabled:number.sending_enabled})}>Configure</Button>{!number.threads&&<Button size="sm" variant="ghost" aria-label={`Remove ${number.phone_number}`} disabled={busy} onClick={()=>{if(window.confirm('Remove this number mapping? The number stays in your WhatsApp Business Account.'))void action({action:'remove_number',id:number.id});}}><Trash2 className="size-4"/></Button>}</div></div>{mapping?.id===number.id&&<div className="mt-4">{editor}</div>}</div>)}
          {!overviewLoading&&overview&&!overview.numbers.length&&<div className="rounded-xl border border-dashed p-8 text-center"><Phone className="mx-auto mb-3 size-8 text-green-600"/><p className="text-sm font-medium">Map your first WhatsApp number</p><p className="mt-1 text-xs text-muted-foreground">Choose a connected number from the WhatsApp Business Account, assign it to the Contact Center messaging profile and pick the queue it serves.</p></div>}
          {mapping&&!mapping.id&&editor}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>WhatsApp number inventory</CardTitle><p className="text-xs text-muted-foreground">Numbers registered on the WhatsApp Business Account{credentials?.source==='backup'?' of the backup Telnyx account':''}. Numbers not mapped here keep their current messaging profile.</p></CardHeader><CardContent>{inventoryLoading?<Loading label="Loading WhatsApp numbers"/>:<ResourceTable rows={inventory} columns={[[ 'phoneNumber','Number'],['displayName','Display name'],['status','Status',value=><StatusBadge value={value}/>],['qualityRating','Quality',value=><StatusBadge value={value}/>],['enabled','Enabled',value=>value?<Status enabled>Enabled</Status>:<Status>Disabled</Status>],['managed','Contact Center',value=>value?<Status enabled>Mapped · {value.name}</Status>:'—']]}/>}</CardContent></Card>
      </>}
      {tab==='details'&&<>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><KeyRound className="size-4 text-green-600"/>Telnyx account for WhatsApp</CardTitle><p className="text-xs text-muted-foreground">The WhatsApp Business Account is looked up on the primary Telnyx API key first (TELNYX_API_KEY). When it has no WhatsApp Business Account, the backup key (TELNYX_API_KEY_WHATSAPP) is used for every WhatsApp operation.</p></CardHeader><CardContent className="space-y-3 text-xs">
          <div className="flex flex-wrap items-center gap-2"><Status enabled={Boolean(credentials?.resolved)} >{credentials?.resolved?`Using the ${credentials.source} key`:'No WhatsApp Business Account found on the configured keys'}</Status>{credentials?.checkedAt&&<span className="text-muted-foreground">Checked {date(credentials.checkedAt)}</span>}<Button size="sm" variant="outline" disabled={busy} onClick={()=>void action({action:'refresh_credentials'},'Credentials re-checked')}><RefreshCw className="mr-1 size-3.5"/>Re-check</Button></div>
          <ResourceTable rows={credentials?.checks||[]} columns={[[ 'source','API key',value=>value==='primary'?'TELNYX_API_KEY (primary)':'TELNYX_API_KEY_WHATSAPP (backup)'],['configured','Configured',value=>value?<Status enabled>Configured</Status>:<Status>Missing</Status>],['wabaCount','WhatsApp Business Accounts'],['error','Error',value=>value||'—']]} empty="No API key configured."/>
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2"><Webhook className="size-4 text-green-600"/>Contact Center webhook</CardTitle><p className="text-xs text-muted-foreground">Telnyx delivers <code>message.received</code> and delivery receipts for every WhatsApp number on a connected messaging profile to this signed endpoint.</p></CardHeader><CardContent className="space-y-3 text-xs">
          <div className="grid gap-3 sm:grid-cols-2"><div><p className="text-muted-foreground">Webhook URL</p><p className="mt-1 break-all font-mono" data-testid="whatsapp-webhook-url">{overview?.webhookUrl||overview?.webhookError||overview?.webhookPath}</p></div><div className="space-y-2"><p className="text-muted-foreground">Server configuration</p><div className="flex flex-wrap gap-2"><Status enabled={overview?.credentialsConfigured}>{overview?.credentialsConfigured?'API key configured':'API key missing'}</Status><Status enabled={overview?.webhookKeyConfigured}>{overview?.webhookKeyConfigured?'Signature key configured':'Signature key missing'}</Status>{credentials?.source==='backup'&&<Status enabled={overview?.backupWebhookKeyConfigured}>{overview?.backupWebhookKeyConfigured?'Backup account signature key configured':'Backup account signature key missing (TELNYX_WEBHOOK_PUBLIC_KEY_WHATSAPP)'}</Status>}</div></div></div>
          {overview?.webhookError&&<p role="alert" className="text-destructive">{overview.webhookError}</p>}
          <p className="leading-relaxed text-muted-foreground">Inbound WhatsApp messages follow the messaging profile assigned to each number. Mapping a number under Numbers points it at the Contact Center profile below; numbers used elsewhere keep their own profile and webhook.</p>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Connected messaging profiles</CardTitle></CardHeader><CardContent className="space-y-4">
          {connectedProfiles.map(profile=><div key={profile.id} data-testid="whatsapp-profile" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"><div><div className="flex items-center gap-2 text-sm font-semibold"><Link2 className="size-4 text-green-600"/>{profile.name||profile.id}</div><p className="mt-1 break-all text-xs text-muted-foreground">{profile.id} · {profile.number_count} mapped number{profile.number_count===1?'':'s'} · {profile.credential_source} key</p><p className="mt-1 break-all text-[10px] text-muted-foreground">{profile.webhook_url||'No webhook URL'}{profile.webhook_api_version?` · API v${profile.webhook_api_version}`:''}</p>{profile.last_error&&<p className="mt-2 text-xs text-destructive">{profile.last_error}</p>}</div><div className="flex items-center gap-2"><Status enabled={Boolean(profile.webhook_verified_at)&&profile.webhook_url===overview?.webhookUrl}>{profile.webhook_verified_at&&profile.webhook_url===overview?.webhookUrl?`Webhook verified ${date(profile.webhook_verified_at)}`:'Webhook needs verification'}</Status><Button size="sm" variant="outline" disabled={busy} onClick={()=>action({action:'connect_profile',profileId:profile.id})}>Verify webhook</Button>{!profile.number_count&&<Button size="sm" variant="ghost" disabled={busy} onClick={()=>{if(window.confirm('Disconnect this profile from Contact Center? It is not deleted in Telnyx.'))void action({action:'disconnect_profile',profileId:profile.id});}}>Disconnect</Button>}</div></div>)}
          {!connectedProfiles.length&&<p className="py-4 text-center text-sm text-muted-foreground">No messaging profile connected yet.</p>}
          <div className="grid gap-4 md:grid-cols-2">
            <form className="space-y-3 rounded-xl border bg-muted/20 p-4" onSubmit={e=>{e.preventDefault();void action({action:'connect_profile',profileId:profileChoice});}}><p className="text-sm font-medium">Connect an existing profile</p><Field label="Telnyx messaging profile"><SearchableSelect value={profileChoice} onChange={setProfileChoice} disabled={inventoryLoading} options={profiles.map(p=>({value:p.id,label:p.name||p.id,description:p.connected?'connected':p.id}))} placeholder="Select profile" searchPlaceholder="Filter profiles by name…" emptyText="No messaging profile matches." data-testid="whatsapp-profile-picker"/></Field><p className="text-[10px] text-muted-foreground">Connecting sets the webhook URL and API version 2 on the profile of the account that owns the WhatsApp Business Account.</p><Button size="sm" disabled={busy||!profileChoice}><Link2 className="mr-1 size-3.5"/>Connect profile</Button></form>
            <form className="space-y-3 rounded-xl border bg-muted/20 p-4" onSubmit={e=>{e.preventDefault();void action({action:'connect_profile',create:true,name:newProfileName});}}><p className="text-sm font-medium">Create a Contact Center profile</p><Field label="Profile name"><Input required value={newProfileName} onChange={e=>setNewProfileName(e.target.value)}/></Field><p className="text-[10px] text-muted-foreground">Creates a new messaging profile with the webhook already configured. Recommended when the WhatsApp Business Account is shared with another application.</p><Button size="sm" variant="outline" disabled={busy||!newProfileName.trim()}><Plus className="mr-1 size-3.5"/>Create and connect</Button></form>
          </div>
        </CardContent></Card>
        <Card><CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3"><div><CardTitle className="flex items-center gap-2"><Building2 className="size-4 text-green-600"/>WhatsApp Business Account</CardTitle><p className="mt-1 text-xs text-muted-foreground">Accounts visible on the resolved Telnyx key.</p></div>
          <div className="flex items-center gap-2"><Select value={accountId||undefined} onValueChange={setAccountId}><SelectTrigger className="min-w-64" aria-label="WhatsApp Business Account" data-testid="whatsapp-account-choice"><SelectValue placeholder="Select account"/></SelectTrigger><SelectContent>{accounts.map(a=><SelectItem key={a.id} value={a.id} textValue={`${a.name} ${a.wabaId}`}>{a.name||a.id} · {a.wabaId}{a.phoneNumbersCount?` · ${a.phoneNumbersCount} number${a.phoneNumbersCount===1?'':'s'}`:''}{a.connected?' · connected':''}</SelectItem>)}</SelectContent></Select>
            {accountId&&(connectedAccount?<Button size="sm" variant="ghost" disabled={busy} onClick={()=>void action({action:'disconnect_account',accountId},'Account disconnected')}>Disconnect</Button>:<Button size="sm" disabled={busy} onClick={()=>void action({action:'connect_account',accountId},'Account connected')}><Link2 className="mr-1 size-3.5"/>Connect</Button>)}</div></CardHeader>
          <CardContent>{accountLoading&&!accountDetail?<Loading label="Loading account"/>:accountDetail?<div className="grid gap-6 xl:grid-cols-[minmax(0,1.5fr)_minmax(280px,0.7fr)]">
            <div className="grid gap-4 md:grid-cols-2"><CopyValue label="Account ID" value={accountDetail.account.id}/><CopyValue label="WABA ID" value={accountDetail.account.wabaId}/><CopyValue label="Account name" value={accountDetail.account.name}/><CopyValue label="Country" value={accountDetail.account.country}/>
              <div className="space-y-1.5"><p className="text-xs text-muted-foreground">Status</p><div className="flex flex-wrap gap-2"><StatusBadge value={accountDetail.account.status}/><StatusBadge value={accountDetail.account.accountReviewStatus}/><StatusBadge value={accountDetail.account.businessVerificationStatus}/></div></div>
              <div className="space-y-1.5"><p className="text-xs text-muted-foreground">Created · Last settings update</p><div className="flex min-h-9 items-center rounded-md border bg-muted/20 px-3 text-xs">{date(accountDetail.account.createdAt)} · {date(accountDetail.settings?.updatedAt)}</div></div></div>
            <div className="space-y-3 rounded-xl border p-4"><p className="text-sm font-medium">Readiness</p>{whatsappReadinessItems(accountDetail.account,accountDetail.settings,accountDetail.phoneNumbers).map(item=><div key={item.label} className="flex items-center gap-3">{item.ready?<CheckCircle2 className="size-5 shrink-0 text-emerald-500"/>:<CircleOff className="size-5 shrink-0 text-amber-500"/>}<div className="min-w-0"><p className="text-xs font-medium">{item.label}</p><p className="truncate text-[10px] text-muted-foreground">{humanize(item.value)}</p></div></div>)}</div>
          </div>:<p className="py-4 text-center text-sm text-muted-foreground">{accounts.length?'Select a WhatsApp Business Account to see its details.':'No WhatsApp Business Account is visible on the configured Telnyx keys.'}</p>}</CardContent></Card>
        {accountDetail?.settings&&<AccountSettingsForm account={accountDetail.account} settings={accountDetail.settings} busy={busy} onSave={form=>action({action:'save_account_settings',accountId:accountDetail.account.id,settings:form},'WABA settings saved')}/>}
      </>}
      {tab==='templates'&&<WhatsAppTemplatesSection account={accountDetail?.account||accounts.find(a=>a.id===accountId)||connectedAccount||null} accounts={accounts} busy={busy} setBusy={setBusy}/>}
      {tab==='phone-numbers'&&<WhatsAppPhoneNumbersSection account={accountDetail?.account||connectedAccount||null} phoneNumbers={scopedNumbers} profiles={connectedProfiles} loading={inventoryLoading||accountLoading} busy={busy} setBusy={setBusy} onChanged={()=>{void refresh().catch(e=>setError(e.message));setResourceRevision(r=>r+1);}}/>}
      {tab==='delivery'&&<>
        <Card><CardHeader><CardTitle>Outbound delivery</CardTitle><p className="text-xs text-muted-foreground">Sent means WhatsApp accepted the message. Delivered means it reached the phone; Read means the customer opened it.</p></CardHeader><CardContent><ResourceTable loading={resourceLoading} rows={deliveries} columns={[[ 'created_at','Sent',value=>date(value)],['business_number','From'],['customer_address','To',(value,row)=>row.customer_name?`${row.customer_name} · ${value}`:value],['agent','Agent'],['kind','Type',value=>humanize(value)],['text','Message'],['status','Status',(value,row)=><DeliveryBadge row={row}/>],['error_detail','Provider error',(value,row)=>value?`${row.error_code?`${row.error_code} · `:''}${value}`:'—']]}/></CardContent></Card>
        <Card><CardHeader><CardTitle>Inbound processing</CardTitle><p className="text-xs text-muted-foreground">Unmatched events arrived for numbers that are not mapped. Failed events did not reach the queue; resolve the error and retry.</p></CardHeader><CardContent className="space-y-4"><ResourceTable loading={overviewLoading} rows={overview?.ingestionFailures||[]} columns={[[ 'received_at','Received',value=>date(value)],['event_type','Event'],['from_number','From'],['to_number','To'],['text','Text'],['status','Status',value=><Badge variant="outline" className={value==='dead'?'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300':'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-300'}>{value==='dead'?'Failed':value==='unmatched'?'Unmatched':'Retrying'}</Badge>],['last_error','Error']]} action={row=>row.status!=='unmatched'&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>action({action:'retry_ingestion',eventId:row.event_id,requestId:crypto.randomUUID()},'Message retry requested')}>Retry</Button>}/><ResourceTable loading={overviewLoading} rows={overview?.audit||[]} columns={[[ 'created_at','Time',value=>date(value)],['action','Admin action'],['resource_id','Resource'],['actor_name','Administrator']]}/></CardContent></Card>
      </>}
      {tab==='copilot'&&copilot&&<div className="w-full space-y-4"><ChatCopilotSettings key={copilotRevision} value={copilot} onChange={setCopilot} disabled={busy} channel="whatsapp" showRefresh={false}/><Button disabled={busy} onClick={()=>action({action:'save_copilot',settings:copilot})}><Save className="mr-2 size-4"/>Save WhatsApp Copilot</Button></div>}
    </>}
    </div>
    </section>
  </main></>;
}
