"use client";
import { useCallback,useEffect,useRef,useState } from 'react';
import { Activity,BookOpen,Brain,Check,Eye,Globe,Inbox,Plus,RefreshCw,Save,Shield,Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { notify } from '@/components/ToastNotify';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { SectionRail,SECTION_RAIL_PAGE_GRID_CLASS,SECTION_RAIL_WIDTH } from '@/components/ui/section-rail';
import { AdminPageHeader } from '@/components/contact-center/WorkspacePageLayout';
import ChatCopilotSettings from '@/components/admin/ChatCopilotSettings';
import EmailTemplateDesigner from './EmailTemplateDesigner';
import EmailPreviewSettings from './EmailPreviewSettings';

const EMAIL_SECTIONS=[
  {id:'mailboxes',label:'Mailboxes',icon:Inbox,description:'Create inboxes and map them to Contact Center queues'},
  {id:'domain',label:'Domain & DNS',icon:Globe,description:'Add mail domains and verify their DNS records'},
  {id:'templates',label:'Templates',icon:BookOpen,description:'Manage shared email templates'},
  {id:'preview',label:'Preview',icon:Eye,description:'Set the global email format and image display policy'},
  {id:'filters',label:'Sender filters',icon:Shield,description:'Manage inbox filters and sending suppressions'},
  {id:'delivery',label:'Delivery',icon:Activity,description:'Review recipient delivery and integration activity'},
  {id:'copilot',label:'AI Copilot',icon:Brain,description:'Configure the email assistant and knowledge sources'},
];
const rowsOf=result=>Array.isArray(result?.data)?result.data:Array.isArray(result)?result:[];
async function api(params={},body){
  const response=await fetch(`/api/admin/email${Object.keys(params).length?`?${new URLSearchParams(params)}`:''}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Email administration unavailable');return result;
}
function Field({label,children}){return <label className="block space-y-1.5 text-xs font-medium">{label}{children}</label>;}
function Status({enabled,children}){return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-medium ${enabled?'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300':'bg-muted text-muted-foreground'}`}>{enabled&&<Check className="size-3"/>}{children}</span>;}
function DnsStatus({status}){
  const normalized=String(status||'pending').toLowerCase().replaceAll(/[\s-]+/g,'_');
  const color=['verified','valid','active','success','passed'].includes(normalized)?'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
    :['pending','verifying','pending_verification','unverified','checking','not_checked','missing_optional'].includes(normalized)?'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-300'
    :['failed','degraded','suspended','invalid','error','missing','mismatch','not_verified'].includes(normalized)?'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300'
    :'border-border bg-muted text-muted-foreground';
  return <Badge variant="outline" className={color}>{String(status||'pending').replaceAll('_',' ')}</Badge>;
}
function IngestionStatus({status}){
  const failed=status==='dead';
  return <Badge variant="outline" className={failed?'border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300':'border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-300'}>{failed?'Failed':'Retrying'}</Badge>;
}
function ResourceTable({rows,columns,action,loading=false,error}){
  if(loading)return <div className="rounded-xl border p-4"><EmailLoading label="Loading records"/></div>;
  if(error&&!rows.length)return null;
  return <div className="overflow-auto rounded-xl border"><table className="w-full text-left text-xs"><thead className="bg-muted/50"><tr>{columns.map(([key,label])=><th key={key} className="whitespace-nowrap p-3 font-medium">{label}</th>)}{action&&<th className="p-3">Actions</th>}</tr></thead><tbody>{rows.map((row,i)=><tr key={row.id||i} className="border-t">{columns.map(([key,,render])=><td key={key} className="max-w-80 break-words p-3">{render?render(row[key]):typeof row[key]==='object'?JSON.stringify(row[key]):String(row[key]??'—')}</td>)}{action&&<td className="p-3">{action(row)}</td>}</tr>)}{!rows.length&&<tr><td colSpan={columns.length+Number(Boolean(action))} className="p-6 text-center text-muted-foreground">No records to display.</td></tr>}</tbody></table></div>;
}

function EmailLoading({label='Loading email configuration',rows=3}){
  return <div role="status" aria-label={label} className="space-y-4"><span className="sr-only">{label}</span>{Array.from({length:rows},(_,i)=><div key={i} className="space-y-2"><Skeleton className="h-4 w-1/3"/><Skeleton className="h-9 w-full"/></div>)}</div>;
}
function MailboxEditor({mapping,setMapping,inboxes,queues,busy,onSave}){
  return <form onSubmit={async e=>{e.preventDefault();if(await onSave())setMapping(null);}} className="space-y-4 rounded-xl border bg-muted/20 p-4"><div className="grid gap-3 sm:grid-cols-3"><Field label="Mailbox name"><Input required value={mapping.name} onChange={e=>setMapping({...mapping,name:e.target.value})}/></Field><Field label="Telnyx inbox"><select required disabled={Boolean(mapping.id)} className="h-9 w-full rounded-md border bg-background px-2" value={mapping.inboxId} onChange={e=>setMapping({...mapping,inboxId:e.target.value})}><option value="">Select inbox</option>{inboxes.map(i=><option key={i.id} value={i.id}>{i.email||i.email_address||i.address}</option>)}</select></Field><Field label="Queue"><select required className="h-9 w-full rounded-md border bg-background px-2" value={mapping.queueId} onChange={e=>setMapping({...mapping,queueId:e.target.value})}><option value="">Select queue</option>{queues.map(q=><option key={q.id} value={q.id}>{q.name}{!q.email_enabled?' (enable Email in Utilization)':''}</option>)}</select></Field></div><div className="flex flex-wrap gap-6"><label className="flex items-center gap-2 text-xs"><Switch checked={mapping.routingEnabled} onCheckedChange={v=>setMapping({...mapping,routingEnabled:v})}/>Route incoming email</label><label className="flex items-center gap-2 text-xs"><Switch checked={mapping.sendingEnabled} onCheckedChange={v=>setMapping({...mapping,sendingEnabled:v})}/>Allow agent replies</label></div><div className="flex gap-2"><Button size="sm" disabled={busy}><Save className="mr-1 size-3.5"/>Save mailbox</Button><Button type="button" size="sm" variant="ghost" onClick={()=>setMapping(null)}>Cancel</Button></div></form>;
}
function InboxInventory({inboxes,mailboxes}){
  const date=value=>value?new Date(value).toLocaleString():'—';
  return <div className="space-y-3" aria-label="Telnyx inboxes">
    {inboxes.map(inbox=>{
      const email=inbox.email||inbox.email_address||inbox.address;
      const connected=mailboxes.filter(mailbox=>mailbox.provider_inbox_id===inbox.id);
      return <article key={inbox.id} data-testid="email-inbox" className="space-y-4 rounded-xl border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold"><Inbox className="size-4 shrink-0 text-amber-500"/><span className="break-all">{email}</span></h3><DnsStatus status={inbox.status||'unknown'}/></div>
        <dl className="grid gap-3 text-xs sm:grid-cols-2 xl:grid-cols-4">{[['Domain',inbox.domain||email?.split('@')[1]],['Queue',connected.map(m=>m.queue_name||m.name).join(', ')||'Not connected'],['Created',date(inbox.created_at)],['Updated',date(inbox.updated_at)]].map(([label,value])=><div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-words">{value||'—'}</dd></div>)}</dl>
        <details className="text-xs"><summary className="w-fit cursor-pointer text-muted-foreground">Inbox details</summary><dl className="mt-3 grid gap-3 sm:grid-cols-2">{[['Inbox ID',inbox.id],['Domain ID',inbox.domain_id],['Record type',inbox.record_type]].map(([label,value])=><div key={label} className="min-w-0"><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 break-all">{value||'—'}</dd></div>)}<div className="min-w-0"><dt className="text-muted-foreground">Settings</dt><dd className="mt-1">{inbox.settings&&Object.keys(inbox.settings).length?<pre className="whitespace-pre-wrap break-all">{JSON.stringify(inbox.settings,null,2)}</pre>:'Default settings'}</dd></div></dl></details>
      </article>;
    })}
    {!inboxes.length&&<p className="py-6 text-center text-sm text-muted-foreground">No inboxes yet. Create an inbox using the form above.</p>}
  </div>;
}

export default function EmailAdmin(){
  const [tab,setTab]=useState('mailboxes'),[overview,setOverview]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [domains,setDomains]=useState([]),[inboxes,setInboxes]=useState([]),[domainId,setDomainId]=useState(''),[resource,setResource]=useState(null),[health,setHealth]=useState(null),[domainName,setDomainName]=useState('');
  const [mapping,setMapping]=useState(null),[username,setUsername]=useState(''),[template,setTemplate]=useState(null),[copilot,setCopilot]=useState(null);
  const [filterInbox,setFilterInbox]=useState(''),[filterType,setFilterType]=useState('blocklist'),[filterLists,setFilterLists]=useState({allowlist:[],blocklist:[]}),[blockAddress,setBlockAddress]=useState(''),[suppressions,setSuppressions]=useState([]),[domainError,setDomainError]=useState(''),[inboxError,setInboxError]=useState('');
  const [overviewLoading,setOverviewLoading]=useState(true),[inventoryLoading,setInventoryLoading]=useState(true),[resourceLoading,setResourceLoading]=useState(false);
  const [filterLoading,setFilterLoading]=useState(false),[filterReady,setFilterReady]=useState(false),[templateLoading,setTemplateLoading]=useState(false);
  const refreshRevision=useRef(0),filterRevision=useRef(0),templateRevision=useRef(0);
  const loadRevision=useRef(0);
  const [resourceRevision,setResourceRevision]=useState(0);
  const [copilotRevision,setCopilotRevision]=useState(0);
  const refresh=useCallback(async()=>{
    const revision=++refreshRevision.current;setOverviewLoading(true);setInventoryLoading(true);
    try{
      const [summary,...results]=await Promise.allSettled([api(),api({resource:'domains'}),api({resource:'inboxes'})]);
      if(revision!==refreshRevision.current)return;
      if(summary.status==='fulfilled'){setOverview(summary.value);setCopilot(current=>current||summary.value.copilot);}
      if(results[0].status==='fulfilled'){const rows=rowsOf(results[0].value);setDomains(rows);setDomainId(current=>rows.some(row=>row.id===current)?current:rows[0]?.id||'');}
      if(results[1].status==='fulfilled')setInboxes(rowsOf(results[1].value));
      setDomainError(results[0].status==='rejected'?results[0].reason.message:'');
      setInboxError(results[1].status==='rejected'?results[1].reason.message:'');
      if(summary.status==='rejected')throw summary.reason;
    }finally{if(revision===refreshRevision.current){setOverviewLoading(false);setInventoryLoading(false);}}
  },[]);
  useEffect(()=>{void refresh().catch(e=>setError(e.message));},[refresh]);
  const loadTab=useCallback(async()=>{
    const revision=++loadRevision.current;
    setResource(null);setHealth(null);setError('');setResourceLoading(true);
    try{
      if(tab==='domain'&&domainId){
        const results=await Promise.allSettled(['dns','health'].map(resource=>api({resource,domainId})));
        if(revision!==loadRevision.current)return;
        if(results[0].status==='fulfilled')setResource(results[0].value);
        if(results[1].status==='fulfilled')setHealth(results[1].value.data||results[1].value);
        const failures=results.filter(r=>r.status==='rejected');if(failures.length)throw Error(failures.map(r=>r.reason.message).join(' · '));
      }
      if(['templates','delivery','filters'].includes(tab)){
        const data=await api({resource:{templates:'templates',delivery:'deliveries',filters:'suppressions'}[tab]});
        if(revision!==loadRevision.current)return;
        if(tab==='filters')setSuppressions(rowsOf(data));else setResource(data);
      }
    }catch(error){if(revision===loadRevision.current)throw error;}
    finally{if(revision===loadRevision.current)setResourceLoading(false);}
  },[tab,domainId]);
  useEffect(()=>{void loadTab().catch(e=>setError(e.message));},[loadTab,resourceRevision]);
  async function loadFilter(id){
    const revision=++filterRevision.current;setFilterInbox(id);setFilterReady(false);setFilterLists({allowlist:[],blocklist:[]});setFilterLoading(Boolean(id));
    if(!id)return;
    try{const result=await api({resource:'filters',id});if(revision!==filterRevision.current)return;const data=result.data||result;if(!Array.isArray(data.allowlist)||!Array.isArray(data.blocklist))throw Error('Invalid inbox filter response');setFilterLists({allowlist:data.allowlist,blocklist:data.blocklist});setFilterType('blocklist');setFilterReady(true);}
    catch(e){if(revision===filterRevision.current)setError(e.message);}
    finally{if(revision===filterRevision.current)setFilterLoading(false);}
  }
  async function loadTemplate(id){
    const revision=++templateRevision.current;setTemplate(null);setTemplateLoading(true);
    try{const result=await api({resource:'template',id});if(revision===templateRevision.current)setTemplate(result.data);}
    catch(e){if(revision===templateRevision.current)setError(e.message);}
    finally{if(revision===templateRevision.current)setTemplateLoading(false);}
  }
  async function action(body){
    setBusy(true);setError('');
    try{
      const result=await api({},body);
      notify({title:body.action==='retry_ingestion'?'Message retry requested':'Changes saved',description:result.warning,variant:result.warning?'warning':'success'});
      if(body.action==='create_domain'&&result.result?.data?.id)setDomainId(result.result.data.id);
      await refresh().catch(e=>notify({title:'Changes saved, but refresh failed',description:e.message,variant:'warning'}));
      setResourceRevision(revision=>revision+1);return result;
    }catch(e){notify({title:'Email action failed',description:e.message,variant:'error'});return null;}finally{setBusy(false);}
  }
  const resourceError=[domainError,inboxError].filter(Boolean).join(' · ');
  const mappingEditor=mapping&&<MailboxEditor mapping={mapping} setMapping={setMapping} inboxes={inboxes} queues={overview?.queues||[]} busy={busy||inventoryLoading} onSave={()=>action({action:'save_mailbox',...mapping,domainId})}/>;
  const domain=domains.find(d=>d.id===domainId);
  const activeSection=EMAIL_SECTIONS.find(section=>section.id===tab);
  const dns=rowsOf(resource).length?rowsOf(resource):resource?.data?.dns_records||resource?.dns_records||resource?.data?.records||[];
  async function refreshAll(){setBusy(true);setCopilotRevision(revision=>revision+1);try{await refresh();setResourceRevision(revision=>revision+1);}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <><AdminPageHeader title="Email" actions={<Button size="sm" variant="outline" disabled={busy} onClick={refreshAll}><RefreshCw className="mr-2 size-3.5"/>Refresh</Button>}/><main className={`${SECTION_RAIL_PAGE_GRID_CLASS} overflow-hidden`} style={{gridTemplateColumns:`${SECTION_RAIL_WIDTH} minmax(0,1fr)`}} data-testid="email-admin">
    <SectionRail items={EMAIL_SECTIONS} activeId={tab} onSelect={setTab} ariaLabel="Email administration sections" screenGroup="admin.email"/>
    <section aria-label={`${activeSection.label} configuration`} className="flex min-h-0 min-w-0 flex-col overflow-hidden" data-testid="email-admin-content">
    <div className={tab==='templates'?'flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto lg:overflow-hidden':'min-h-0 flex-1 space-y-5 overflow-y-auto pr-1 pb-4'}>
      {(error||resourceError)&&<p role="alert" className="shrink-0 rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{error||resourceError}</p>}
      {overviewLoading&&!overview?<Card><CardContent className="p-6"><EmailLoading label={`Loading ${activeSection.label}`} rows={5}/></CardContent></Card>:<>
      {tab==='mailboxes'&&<>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[['Connected mailboxes',overview?.mailboxes.length||0],['Routing enabled',overview?.mailboxes.filter(m=>m.routing_enabled).length||0],['Awaiting routing',overview?.mailboxes.reduce((n,m)=>n+m.backlog,0)||0],['Needs attention',overview?.mailboxes.reduce((n,m)=>n+(m.ingest_failed||0)+(m.ingest_retrying||0),0)||0]].map(([label,value])=><Card key={label}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{label}</p><div className="mt-2 text-2xl font-semibold">{overviewLoading?<Skeleton className="h-8 w-12"/>:overview?value:'—'}</div></CardContent></Card>)}</div>
        <Card><CardHeader className="flex flex-row items-center justify-between"><div><CardTitle>Queue mailboxes</CardTitle><p className="mt-1 text-xs text-muted-foreground">Map an inbox to a queue. Pause routing independently from mail capture.</p></div><Button size="sm" onClick={()=>setMapping({name:'',inboxId:'',queueId:'',routingEnabled:false,sendingEnabled:false})}><Plus className="mr-1 size-4"/>Connect inbox</Button></CardHeader><CardContent className="space-y-4">
          {overviewLoading?<EmailLoading label="Loading queue mailboxes"/>:overview?.mailboxes.map(mailbox=><div key={mailbox.id} data-testid="queue-mailbox" className="rounded-xl border p-4"><div className="flex flex-wrap items-center justify-between gap-4"><div><div className="flex items-center gap-2 text-sm font-semibold"><Inbox className="size-4 text-amber-500"/>{mailbox.name}</div><p className="mt-1 text-xs text-muted-foreground">{mailbox.address} → {mailbox.queue_name}</p><p className="mt-2 text-[10px] text-muted-foreground">{mailbox.last_error||`Last sync: ${mailbox.last_synced_at?new Date(mailbox.last_synced_at).toLocaleString():'Not synchronized yet'}`} · {mailbox.backlog} awaiting routing</p>{Boolean(mailbox.ingest_failed||mailbox.ingest_retrying)&&<div role="status" className="mt-3 space-y-2"><div className="flex flex-wrap items-center gap-2">{mailbox.ingest_failed>0&&<Badge variant="outline" className="border-red-500/20 bg-red-500/10 text-red-700 dark:text-red-300">{mailbox.ingest_failed} failed</Badge>}{mailbox.ingest_retrying>0&&<Badge variant="outline" className="border-amber-500/20 bg-amber-500/10 text-amber-800 dark:text-amber-300">{mailbox.ingest_retrying} retrying</Badge>}<Button variant="link" size="sm" className="h-auto p-0 text-xs text-foreground" onClick={()=>setTab('delivery')}>Review processing errors</Button></div><p className="max-w-xl break-words text-xs text-destructive">{mailbox.last_ingest_error}</p></div>}</div><div className="flex items-center gap-2"><Status enabled={mailbox.routing_enabled}>{mailbox.routing_enabled?'Routing':'Routing paused'}</Status><Status enabled={mailbox.sending_enabled}>{mailbox.sending_enabled?'Sending':'Sending paused'}</Status><Button size="sm" variant="ghost" disabled={busy} onClick={()=>action({action:'sync',id:mailbox.id})}>Sync</Button><Button size="sm" variant="outline" onClick={()=>setMapping({id:mailbox.id,version:mailbox.version,name:mailbox.name,inboxId:mailbox.provider_inbox_id,queueId:mailbox.queue_id,routingEnabled:mailbox.routing_enabled,sendingEnabled:mailbox.sending_enabled})}>Configure</Button></div></div>{mapping?.id===mailbox.id&&<div className="mt-4">{mappingEditor}</div>}</div>)}
          {!overviewLoading&&overview&&!overview.mailboxes.length&&<div className="rounded-xl border border-dashed p-8 text-center"><Inbox className="mx-auto mb-3 size-8 text-amber-400"/><p className="text-sm font-medium">Connect your first inbox</p><p className="mt-1 text-xs text-muted-foreground">Create an inbox on your verified domain, then assign it to a Contact Center queue.</p></div>}

          {mapping&&!mapping.id&&mappingEditor}
        </CardContent></Card>
        <Card><CardHeader><CardTitle>Inboxes</CardTitle></CardHeader><CardContent className="space-y-5"><form onSubmit={async e=>{e.preventDefault();if(await action({action:'create_inbox',domainId,username}))setUsername('');}} className="flex flex-wrap items-end gap-3"><Field label="Mail domain"><select required disabled={busy||inventoryLoading||!domains.length} className="h-9 w-full rounded-md border bg-background px-2" value={domainId} onChange={e=>setDomainId(e.target.value)}><option value="">Select a domain</option>{domains.map(d=><option key={d.id} value={d.id}>{d.domain||d.name}</option>)}</select></Field><Field label="Mailbox address"><div className="flex items-center gap-2"><Input required placeholder="support" value={username} onChange={e=>setUsername(e.target.value)}/>{domain&&<span className="text-xs text-muted-foreground">@{domain.domain||domain.name}</span>}</div></Field><Button disabled={busy||inventoryLoading||!domainId}>Create inbox</Button>{!inventoryLoading&&!domainError&&!domains.length&&<p className="w-full text-xs text-muted-foreground">Add and verify a domain in Domain &amp; DNS first.</p>}</form>{inventoryLoading?<EmailLoading label="Loading inboxes"/>:!inboxError&&<InboxInventory inboxes={inboxes} mailboxes={overview?.mailboxes||[]}/>}</CardContent></Card>
      </>}
      {tab==='domain'&&<>
        <Card><CardHeader><CardTitle>Add a mail domain</CardTitle><p className="text-xs text-muted-foreground">Register a domain or connect one already in your Telnyx account.</p></CardHeader><CardContent><form className="flex flex-wrap items-end gap-3" onSubmit={async e=>{e.preventDefault();if(await action({action:'create_domain',domain:domainName}))setDomainName('');}}><div className="min-w-0 flex-1"><Field label="Domain name"><Input required autoCapitalize="none" autoCorrect="off" placeholder="mail.example.com" value={domainName} onChange={e=>setDomainName(e.target.value)}/></Field></div><Button disabled={busy||!domainName.trim()}><Plus className="mr-2 size-4"/>Add domain</Button></form></CardContent></Card>
        <Card><CardHeader><CardTitle>Sending and receiving domains</CardTitle></CardHeader><CardContent className="space-y-4">{inventoryLoading?<EmailLoading label="Loading mail domains"/>:domains.length?<><div className="flex flex-wrap items-end justify-between gap-3"><Field label="Mail domain"><select className="h-9 w-full rounded-md border bg-background px-2" value={domainId} onChange={e=>setDomainId(e.target.value)}>{domains.map(d=><option key={d.id} value={d.id}>{d.domain||d.name}</option>)}</select></Field><Button disabled={busy||!domainId} onClick={()=>action({action:'verify_domain',domainId})}>Verify DNS</Button></div><div><DnsStatus status={domain?.status}/></div><p className="text-xs leading-relaxed text-muted-foreground">Publish the exact DNS records below with your DNS provider, then verify the domain.</p>{resourceLoading?<Skeleton className="h-12 w-full"/>:health&&<div className="rounded-lg bg-muted/40 p-3 text-xs">{Object.entries(health).filter(([,v])=>['string','boolean','number'].includes(typeof v)).map(([k,v])=><span key={k} className="mr-4 inline-block">{k.replaceAll('_',' ')}: {k==='status'?<DnsStatus status={v}/>:String(v)}</span>)}</div>}<ResourceTable error={error} loading={resourceLoading} rows={Array.isArray(dns)?dns:[]} columns={[[ 'record_type','Type'],['host','Host'],['value','Value'],['status','Status',status=><DnsStatus status={status}/>]]}/></>:!domainError&&<p className="py-4 text-center text-sm text-muted-foreground">No domain added yet. Add a domain to see its DNS records.</p>}</CardContent></Card>
      </>}
      {tab==='templates'&&<EmailTemplateDesigner key={`${templateRevision.current}:${template?.id||'new'}`} contextKey={`${templateRevision.current}:${template?.id||'new'}`} value={template} onChange={setTemplate} loading={templateLoading} disabled={busy}
        onNew={()=>{templateRevision.current++;setTemplateLoading(false);setTemplate({name:'',subject:'',html_body:'',text_body:''});}}
        onCancel={()=>{templateRevision.current++;setTemplate(null);}}
        onSave={async value=>{if(await action({action:'save_template',id:value.id,payload:value})){templateRevision.current++;setTemplate(null);}}}>
        <ResourceTable error={error} loading={resourceLoading} rows={rowsOf(resource)} columns={[[ 'name','Name'],['subject','Subject']]} action={row=><div className="flex gap-2"><Button variant="ghost" size="sm" disabled={busy} onClick={()=>loadTemplate(row.id)}>Edit</Button><Button variant="ghost" size="icon" aria-label={`Delete template ${row.name}`} disabled={busy} onClick={async()=>{if(window.confirm('Delete this shared email template?')&&await action({action:'delete_template',id:row.id})&&template?.id===row.id){templateRevision.current++;setTemplate(null);}}}><Trash2 className="size-4"/></Button></div>}/>
      </EmailTemplateDesigner>}
      {tab==='preview'&&(overviewLoading?<Card><CardContent className="p-6"><EmailLoading label="Loading preview settings"/></CardContent></Card>:overview&&<EmailPreviewSettings key={JSON.stringify(overview.preview)} value={overview.preview} disabled={busy} onSave={settings=>action({action:'save_preview',settings})}/>)}
      {tab==='filters'&&<>
        <Card><CardHeader><CardTitle>Inbox sender filters</CardTitle></CardHeader><CardContent className="space-y-3"><div className="grid gap-3 sm:grid-cols-2"><Field label="Inbox"><select disabled={inventoryLoading} className="h-9 w-full rounded-md border bg-background px-2" value={filterInbox} onChange={e=>loadFilter(e.target.value)}><option value="">Select inbox</option>{inboxes.map(i=><option key={i.id} value={i.id}>{i.email||i.email_address||i.address}</option>)}</select></Field><Field label="Filter policy"><select disabled={filterLoading||!filterReady} className="h-9 w-full rounded-md border bg-background px-2" value={filterType} onChange={e=>setFilterType(e.target.value)}><option value="blocklist">Block these senders</option><option value="allowlist">Allow only these senders</option></select></Field></div><Field label="Email addresses or @domains, one per line">{filterLoading?<EmailLoading label="Loading sender filter" rows={1}/>:<Textarea disabled={!filterReady} value={filterLists[filterType].join('\n')} onChange={e=>setFilterLists(current=>({...current,[filterType]:e.target.value.split('\n')}))} placeholder="sender@example.com"/>}</Field><Button disabled={busy||filterLoading||!filterInbox||!filterReady} onClick={()=>action({action:'save_filters',inboxId:filterInbox,payload:{type:filterType,entries:filterLists[filterType].map(s=>s.trim()).filter(Boolean)}})}>Save sender filters</Button></CardContent></Card>
        <Card><CardHeader><CardTitle>Sending suppressions</CardTitle></CardHeader><CardContent className="space-y-4"><p className="text-xs text-muted-foreground">Suppressions apply to the Telnyx account. Review their reason before removing a block.</p><form className="flex gap-2" onSubmit={e=>{e.preventDefault();void action({action:'create_suppression',address:blockAddress});}}><Input type="email" required aria-label="Suppress recipient" placeholder="recipient@example.com" value={blockAddress} onChange={e=>setBlockAddress(e.target.value)}/><Button disabled={busy}>Block recipient</Button></form><ResourceTable error={error} loading={resourceLoading} rows={suppressions} columns={[[ 'to','Recipient'],['reason','Reason'],['status','Status']]} action={row=><Button variant="ghost" size="sm" disabled={busy} onClick={()=>{if(window.confirm('Remove this sending suppression?'))void action({action:'delete_suppression',id:row.id});}}>Remove</Button>}/></CardContent></Card>
      </>}
      {tab==='delivery'&&<Card><CardHeader><CardTitle>Delivery and recovery</CardTitle><p className="text-xs text-muted-foreground">Accepted means Telnyx accepted the request. Delivered means the receiving mail server accepted the recipient.</p></CardHeader><CardContent className="space-y-4"><ResourceTable error={error} loading={resourceLoading} rows={rowsOf(resource)} columns={[[ 'created_at','Created'],['mailbox','Mailbox'],['subject','Subject'],['status','Send status'],['address','Recipient'],['delivery_status','Delivery'],['evidence','Error evidence']]}/><p className="text-xs text-muted-foreground">Uncertain sends retain their original idempotency key and appear in ACD operations. Review the provider evidence before starting a new send.</p><div className="space-y-3"><h3 className="text-sm font-semibold">Inbound processing</h3><p className="text-xs text-muted-foreground">Failed messages have not reached the queue. Resolve the reported error, then retry the affected message. Mailbox Sync does not retry failed processing.</p><ResourceTable loading={overviewLoading} rows={overview?.ingestionFailures||[]} columns={[[ 'received_at','Received'],['mailbox','Mailbox'],['subject','Subject'],['status','Status',status=><IngestionStatus status={status}/>],['attempt_count','Attempts'],['last_error','Processing error']]} action={row=><Button size="sm" variant="outline" disabled={busy} onClick={()=>action({action:'retry_ingestion',eventId:row.event_id,requestId:crypto.randomUUID()})}>Retry message</Button>}/></div><ResourceTable error={error} loading={overviewLoading} rows={overview?.audit||[]} columns={[[ 'created_at','Time'],['action','Admin action'],['actor_name','Administrator']]}/></CardContent></Card>}
      {tab==='copilot'&&copilot&&<div className="w-full space-y-4"><ChatCopilotSettings key={copilotRevision} value={copilot} onChange={setCopilot} disabled={busy} channel="email" showRefresh={false}/><Button disabled={busy} onClick={()=>action({action:'save_copilot',settings:copilot})}><Save className="mr-2 size-4"/>Save email Copilot</Button></div>}
    </>}
    </div>
    </section>
  </main></>;
}
