"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

import { useEffect, useRef, useState } from 'react';
import { IconBrain } from '@tabler/icons-react';
import { Brain, Check, ChevronRight, LockKeyhole, RotateCcw, Save } from 'lucide-react';
import { SystemSectionPage } from '@/components/admin/SystemSectionNav';
import { AdminPageHeader, AdminPageShell } from '@/components/contact-center/WorkspacePageLayout';
import AiOperationLab from '@/components/admin/AiOperationLab';
import ChatCopilotSettings from '@/components/admin/ChatCopilotSettings';
import AIModels from '@/components/assistants/AIModels';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { notify } from '@/components/ToastNotify';
const channels=['chat','sms','whatsapp','email'];
async function api(body){
  const response=await fetch('/api/admin/ai-operations',body?{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  const data=await response.json();if(!response.ok)throw Error(data.error||'AI settings unavailable');return data;
}
// Platform default model: save it, or make every operation inherit it.
async function defaultApi(method,body){
  const response=await fetch('/api/admin/ai-operations/default',{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.error||'AI settings unavailable');return data;
}
export default function AiCopilotPage(){
  const tUi = useUiText();
  const [data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const [selected,setSelected]=useState('reply-suggestions'),[draft,setDraft]=useState(null),[channel,setChannel]=useState('chat');
  const [copilot,setCopilot]=useState(null),[inherit,setInherit]=useState(false),[saving,setSaving]=useState(false);
  const [models,setModels]=useState([]),[catalogError,setCatalogError]=useState(''),[catalogLoading,setCatalogLoading]=useState(true);
  const editor=useRef(null);
  const [defaultDraft,setDefaultDraft]=useState(null),[savingDefault,setSavingDefault]=useState(false),[confirmApply,setConfirmApply]=useState(false),[applying,setApplying]=useState(false);
  async function load(){setLoading(true);setError('');try{const next=await api();setData(next);setDraft(null);}catch(err){setError(err.message);}finally{setLoading(false);}}
  useEffect(()=>{load();},[]);
  useEffect(()=>{const controller=new AbortController();fetch('/api/admin/system-settings?catalog=copilot',{cache:'no-store',signal:controller.signal})
    .then(async response=>{const next=await response.json();if(!response.ok||next.error)throw Error(next.error||'Model catalog unavailable');setModels(next.models);})
    .catch(err=>{if(err.name!=='AbortError')setCatalogError(err.message);}).finally(()=>{if(!controller.signal.aborted)setCatalogLoading(false);});return()=>controller.abort();},[]);
  const operation=data?.operations.find(item=>item.id===selected);
  const value=draft||operation?.config;
  const effectiveCopilot=copilot||data?.copilots[channel]||data?.copilots.chat;
  const dirty=Boolean(draft||copilot);
  const writable=data?.canEdit&&!saving;
  function choose(id){if(id===selected)return;if(dirty&&!window.confirm(tUi("Discard unsaved changes?")))return;setSelected(id);setDraft(null);setCopilot(null);setChannel('chat');setInherit(false);requestAnimationFrame(()=>{editor.current?.scrollTo({top:0});if(window.innerWidth<1280)editor.current?.scrollIntoView({behavior:'smooth'});});}
  function chooseChannel(next){if(dirty&&!window.confirm(tUi("Discard unsaved changes?")))return;setDraft(null);setCopilot(null);setChannel(next);setInherit(next!=='chat'&&!data.copilots[next]);}
  useEffect(()=>{if(!dirty)return;const guard=event=>{event.preventDefault();event.returnValue='';};window.addEventListener('beforeunload',guard);return()=>window.removeEventListener('beforeunload',guard);},[dirty]);
  async function save(){setSaving(true);try{const next=await api({id:selected,revision:operation.revision,config:value,...(selected==='reply-suggestions'?{channel,copilot:inherit?null:effectiveCopilot}:{})});setData(next);setDraft(null);setCopilot(null);notify({title:'AI settings saved',description:'Applies to subsequent AI requests.',variant:'success'});}catch(err){notify({title:'Save failed',description:err.message,variant:'error'});}finally{setSaving(false);}}
  const options=operation&&value?.model&&!models.some(m=>m.id===value.model)?[{id:value.model,name:value.model},...models]:models;
  const platform=data?.defaultModel;
  const defaultValue=defaultDraft??platform?.saved??'';
  const defaultOptions=defaultValue&&!models.some(m=>m.id===defaultValue)?[{id:defaultValue,name:defaultValue},...models]:models;
  const defaultDirty=defaultDraft!==null&&defaultDraft!==(platform?.saved||'');
  async function saveDefault(model){setSavingDefault(true);try{const next=await defaultApi('PUT',{model,revision:platform.revision});setData(next);setDefaultDraft(null);notify({title:'Default model saved',description:'Applies to subsequent AI requests of every operation without its own model.',variant:'success'});}catch(err){notify({title:'Save failed',description:err.message,variant:'error'});}finally{setSavingDefault(false);}}
  async function applyToAll(){setApplying(true);try{const next=await defaultApi('POST',{action:'apply-to-all',revision:platform.revision});setData(next);setDraft(null);setCopilot(null);setInherit(false);setConfirmApply(false);notify({title:'Default model applied',description:`All ${next.applied.operations} AI operations and the reply suggestion channels now use ${next.defaultModel.model}.`,variant:'success'});}catch(err){notify({title:'Apply failed',description:err.message,variant:'error'});}finally{setApplying(false);}}
  const effectiveBadge=item=>item.effective?.model?(item.effective.source==='ai-copilot'||item.effective.source==='channel'?item.effective.model:tUi("Default · {value0}", { value0: item.effective.model })):tUi("No model configured");
  return <AdminPageShell><AdminPageHeader title={tUi("AI Copilot")} icon={IconBrain}/><SystemSectionPage activeId="ai-copilot">
    {loading?<div role="status" aria-label={tUi("Loading AI operations")} className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_400px]"><div className="grid gap-4 md:grid-cols-2">{Array.from({length:8},(_,i)=><Skeleton key={i} className="h-44 w-full"/>)}</div><Skeleton className="h-96 w-full"/></div>:error?<Card><CardContent className="space-y-4 pt-6"><p role="alert">{error}</p><Button onClick={load}>{tUi("Retry")}</Button></CardContent></Card>:
    <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto pb-4 xl:grid-cols-[minmax(0,1fr)_400px] xl:grid-rows-[minmax(0,1fr)] xl:overflow-hidden">
      <section aria-label={tUi("AI operations")} className="space-y-6 p-1 xl:overflow-y-auto">
        <Card id="ai-default-model" className="border-telnyx-green/40"><CardHeader><CardTitle>{tUi("Platform default model")}</CardTitle><p className="text-sm text-muted-foreground">{tUi("The model for the whole Contact Center. Every AI operation below without its own model uses it. Workflows, scorecards and reply suggestion channels can still choose their own model where they offer a model field.")}</p></CardHeader><CardContent className="space-y-3">
          <div className="space-y-2"><Label htmlFor="ai-default-model-picker">{tUi("Default model")}</Label>{catalogLoading?<Skeleton className="h-10 w-full"/>:<AIModels id="ai-default-model-picker" value={defaultValue} onValueChange={setDefaultDraft} models={defaultOptions} placeholder={platform?.envModel?tUi("From {value0} · {value1}", { value0: platform.envVariable, value1: platform.envModel }):tUi("Not set")} triggerClassName="border bg-background" disabled={!data.canEdit||savingDefault||applying}/>}
          <p className="text-xs text-muted-foreground">{platform?.source==='settings'?tUi("Saved in AI Copilot. {value0} in the environment is used only when nothing is saved here.", { value0: platform.envVariable }):platform?.source==='env'?tUi("Not saved here: the platform uses {value0} = {value1} from the environment.", { value0: platform.envVariable, value1: platform.envModel }):tUi("No default model. AI features fail until you choose one here or set {value0} in the environment.", { value0: platform?.envVariable||'TELNYX_AI_DEFAULT_MODEL' })}</p></div>
          {data.canEdit&&<div className="flex flex-wrap gap-2"><Button onClick={()=>saveDefault(defaultValue)} disabled={!defaultDirty||savingDefault||applying}><Save className="mr-2 size-4"/>{savingDefault?tUi("Saving…"):tUi("Save default model")}</Button>{platform?.saved&&platform?.envModel&&<Button variant="outline" onClick={()=>saveDefault('')} disabled={savingDefault||applying}><RotateCcw className="mr-2 size-4"/>{tUi("Use environment value")}</Button>}<Button variant="secondary" onClick={()=>{if(dirty&&!window.confirm(tUi("Discard unsaved changes?")))return;setConfirmApply(true);}} disabled={!platform?.model||defaultDirty||savingDefault||applying}>{tUi("Apply to all AI operations")}</Button></div>}
          {defaultDirty&&<p className="text-xs text-amber-600 dark:text-amber-400">{tUi("Save the default model before applying it to all operations.")}</p>}
        </CardContent></Card>
        <AlertDialog open={confirmApply} onOpenChange={open=>{if(!applying)setConfirmApply(open);}}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{tUi("Apply the default model to all AI operations?")}</AlertDialogTitle><AlertDialogDescription>{tUi("All {value0} AI operations listed in AI Copilot and every reply suggestion channel will stop using their own model and inherit {value1}. This overwrites their current model settings. Business instructions, token limits and knowledge buckets are kept. Workflow and scorecard models are not changed.", { value0: data.operations.length, value1: platform?.model||'' })}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={applying}>{tUi("Cancel")}</AlertDialogCancel><AlertDialogAction onClick={event=>{event.preventDefault();applyToAll();}} disabled={applying}>{applying?tUi("Applying…"):tUi("Apply to all")}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
        <div><h2 className="text-lg font-semibold">{tUi("AI operations ")}<span className="ml-2 text-sm text-muted-foreground">{data.operations.length}</span></h2><p className="mt-1 text-sm text-muted-foreground">{tUi("Each card is one platform feature that uses an LLM. Select a card to choose its model (empty = platform default) and business guidance in the side panel.")}</p></div>
        {[...new Set(data.operations.map(item=>item.group))].map(group=><div key={group} className="space-y-3"><h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{group}</h3><div className="grid gap-3 2xl:grid-cols-2">{data.operations.filter(item=>item.group===group).map(item=><button type="button" key={item.id} aria-pressed={selected===item.id} aria-controls="ai-operation-editor" onClick={()=>choose(item.id)} className={cn('rounded-2xl border bg-card p-5 text-left transition-colors hover:border-foreground/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',selected===item.id&&'border-telnyx-green bg-telnyx-green/5')}>
          <div className="mb-3 flex items-center gap-3"><span className="rounded-xl bg-violet-500/10 p-2.5 text-violet-500"><Brain className="size-5"/></span><span className="flex-1 font-semibold">{item.title}</span>{selected===item.id?<Check className="size-4 text-telnyx-green"/>:<ChevronRight className="size-4 text-muted-foreground"/>}</div>
          <p className="text-sm text-muted-foreground">{item.description}</p><p className="mt-3 text-xs text-muted-foreground"><span className="font-semibold">{tUi("Used in: ")}</span>{item.usage?.screens[0]}</p><div className="mt-4 flex flex-wrap gap-2"><Badge variant="outline" className="max-w-full break-all whitespace-normal text-xs">{effectiveBadge(item)}</Badge><Badge variant="secondary">{item.config.instructions?tUi("Custom guidance"):tUi("Default instructions")}</Badge></div>
        </button>)}</div></div>)}
      </section>
      <aside ref={editor} id="ai-operation-editor" aria-label={tUi("AI operation configuration")} className="min-w-0 p-1 xl:overflow-y-auto">
        <Card><CardHeader><CardTitle>{operation.title}</CardTitle><p className="text-sm text-muted-foreground">{operation.description}</p></CardHeader><CardContent className="space-y-5">
          {!data.canEdit&&<p className="text-sm text-muted-foreground"><LockKeyhole className="mr-2 inline size-4"/>{tUi("Read-only. Updating requires System settings permission.")}</p>}
          {selected==='reply-suggestions'&&<div className="flex flex-wrap gap-1">{channels.map(item=><Button key={item} disabled={saving} type="button" size="sm" variant={channel===item?'secondary':'ghost'} onClick={()=>chooseChannel(item)}>{item==='sms'?tUi("SMS"):item==='whatsapp'?tUi("WhatsApp"):item==='email'?tUi("Email"):tUi("Chat")}</Button>)}</div>}
          <div className="rounded-xl border p-3"><h3 className="mb-2 text-sm font-semibold">{tUi("Where this is used")}</h3><ul className="list-inside list-disc space-y-1 text-xs text-muted-foreground">{operation.usage?.screens.map(screen=><li key={screen}>{screen}</li>)}</ul><p className="mt-2 text-xs text-muted-foreground">{operation.usage?.context}</p></div>
          <AiOperationLab key={selected} operation={operation} config={value} copilot={selected==='reply-suggestions'?effectiveCopilot:undefined} models={options} canTest={data.canEdit}/>
          <fieldset disabled={!writable} className="min-w-0 space-y-5">
          {selected==='reply-suggestions'?<>
            {channel!=='chat'&&<label className="flex items-center justify-between gap-3 text-sm">{tUi("Use Chat defaults")}<Switch checked={inherit} onCheckedChange={checked=>{setInherit(checked);setCopilot({...effectiveCopilot});}}/></label>}
            <ChatCopilotSettings key={channel} value={effectiveCopilot} onChange={setCopilot} channel={channel} embedded disabled={!writable||inherit} inheritedModel={operation.inherited?.model}/></>:
          <div className="space-y-2"><Label htmlFor="ai-operation-model">{tUi("Model for this operation")}</Label>{catalogLoading?<Skeleton className="h-10 w-full"/>:<AIModels id="ai-operation-model" value={value.model} placeholder={platform?.model?tUi("Platform default · {value0}", { value0: platform.model }):tUi("Platform default · not set")} onValueChange={model=>setDraft({...value,model})} models={options} triggerClassName="border bg-background" disabled={!writable}/>}<p className="text-xs text-muted-foreground">{tUi("Leave empty to inherit the platform default model. A model chosen here overrides it for this operation; a model set on a workflow, scorecard or channel overrides both where that feature offers one.")}</p>{value.model&&writable&&<button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={()=>setDraft({...value,model:''})}>{tUi("Use platform default")}</button>}{catalogError&&<p role="alert" className="text-xs text-destructive">{catalogError}</p>}</div>}
          <div className="space-y-2"><Label htmlFor="ai-operation-guidance">{tUi("Business instructions ")}{selected==='reply-suggestions'?tUi("· all channels"):''}</Label><p className="text-xs text-muted-foreground">{operation.editable}</p><Textarea id="ai-operation-guidance" value={value.instructions} maxLength={6000} rows={8} placeholder={tUi("Leave empty to use built-in instructions.")} onChange={event=>setDraft({...value,instructions:event.target.value})}/><p className="text-right text-xs text-muted-foreground">{value.instructions.length} / 6,000</p></div>
          <div className="flex flex-wrap gap-2"><Button onClick={save} disabled={!dirty||saving}><Save className="mr-2 size-4"/>{saving?tUi("Saving…"):tUi("Save changes")}</Button><Button variant="outline" onClick={()=>{setDraft({model:'',instructions:''});}}><RotateCcw className="mr-2 size-4"/>{tUi("Reset model & guidance")}</Button></div>
          </fieldset>
          <div className="rounded-xl border bg-muted/30 p-4"><h3 className="mb-2 flex items-center gap-2 text-sm font-semibold"><LockKeyhole className="size-4"/>{tUi("Protected technical rules · summary")}</h3><p className="whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground">{operation.contract}</p><p className="mt-3 text-xs text-muted-foreground">{tUi("Read-only summary. Use Full prompt & test lab to inspect all generated instructions for a sample context. Response validation, generated context, schemas and execution limits remain controlled by the application.")}</p></div>
        </CardContent></Card>
      </aside>
    </div>}
  </SystemSectionPage></AdminPageShell>;
}
