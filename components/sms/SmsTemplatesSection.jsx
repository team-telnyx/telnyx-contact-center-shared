"use client";
import { useCallback,useEffect,useMemo,useRef,useState } from 'react';
import dynamic from 'next/dynamic';
import { Archive,Copy,LayoutTemplate,Plus,RefreshCw,Save,Smile,Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@/components/ui/select';
import { Popover,PopoverContent,PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { notify } from '@/components/ToastNotify';
import SmsPhonePreview from './SmsPhonePreview';
import TemplateLanguagePicker from '@/components/messaging/TemplateLanguagePicker';
import { composeSmsMessage,extractSmsTemplateVariables,EMPTY_SMS_TEMPLATE,SMS_FOOTER_MAX_CHARS,SMS_TEMPLATE_CATEGORIES } from '@/lib/sms/templates.mjs';
import { describeSmsSegments } from '@/lib/sms/segments.mjs';
import { SYSTEM_VARIABLES } from '@/lib/outbound-dialer/messaging/variables.mjs';

// Same picker as the agent composer and the WhatsApp sender.
const EmojiPickerPanel=dynamic(()=>import('@/components/messaging/EmojiPickerPanel'),{ssr:false,
  loading:()=><div role="status" aria-label="Loading emojis" className="w-[300px] max-w-full space-y-3 p-2"><Skeleton className="h-6 w-24"/><Skeleton className="h-9 w-full"/><Skeleton className="h-64 w-full"/></div>});
const rowsOf=result=>Array.isArray(result?.data)?result.data:Array.isArray(result)?result:[];
async function api(params={},body){
  const response=await fetch(`/api/admin/sms${Object.keys(params).length?`?${new URLSearchParams(params)}`:''}`,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{cache:'no-store'});
  const result=await response.json();if(!response.ok)throw Error(result.error||'SMS administration unavailable');return result;
}
function Field({label,children,hint}){return <label className="block space-y-1.5 text-xs font-medium">{label}{children}{hint&&<span className="block text-[10px] font-normal text-muted-foreground">{hint}</span>}</label>;}
const CONTACT_VARIABLES=['first_name','last_name','company','order_id','appointment_date','amount'];
// Matches DEFAULT_MESSAGING_SETTINGS.sms until the workspace policy arrives.
const DEFAULT_FOOTER_POLICY={required:true,text:'Reply STOP to opt out',maxSegments:10};
const statusClass=status=>status==='archived'?'border-slate-400/40 bg-slate-500/10 text-slate-600 dark:text-slate-300':'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300';
const formFromRow=row=>({name:row.name||'',category:row.category||'marketing',language:row.language||'en',body:row.body||'',footer_mode:row.footer_mode||'inherit',footer_text:row.footer_text||'',status:row.status||'active',sample_values:row.sample_values&&typeof row.sample_values==='object'?row.sample_values:{}});

// Local SMS templates for outbound campaigns: named {{variables}} filled from
// contact-list fields, an opt-out footer inherited from the dialer settings and
// a live segment counter with the phone preview.
export default function SmsTemplatesSection({busy,setBusy,footerPolicy}){
  const [templates,setTemplates]=useState([]),[loading,setLoading]=useState(true),[selectedId,setSelectedId]=useState(''),[form,setForm]=useState({...EMPTY_SMS_TEMPLATE}),[error,setError]=useState('');
  const [emojiOpen,setEmojiOpen]=useState(false);
  const bodyRef=useRef(null),emojiInserted=useRef(false);
  const policy={...DEFAULT_FOOTER_POLICY,...(footerPolicy||{})};
  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{setTemplates(rowsOf(await api({resource:'templates',status:'all'})));}
    catch(e){setError(e.message);}finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  const selected=templates.find(t=>t.id===selectedId)||null;
  useEffect(()=>{setForm(selected?formFromRow(selected):{...EMPTY_SMS_TEMPLATE});},[selected]);
  const variables=useMemo(()=>extractSmsTemplateVariables(form.body),[form.body]);
  // The preview composes exactly what the runner will send: the workspace
  // policy decides whether a footer is required, the template may override its
  // text, and "no footer" removes it unless compliance keeps it.
  const preview=useMemo(()=>composeSmsMessage({body:form.body,values:form.sample_values||{},footerMode:form.footer_mode,
    requireFooter:policy.required,footerText:policy.text,templateFooterText:form.footer_text}),[form.body,form.sample_values,form.footer_mode,form.footer_text,policy.required,policy.text]);
  // The campaign runner refuses anything over the workspace segment limit, so
  // the editor blocks the save here instead of letting a campaign fail silently.
  const maxSegments=Math.max(1,Number(policy.maxSegments)||10);
  const tooManyParts=preview.segments.tooLong||preview.segments.parts>maxSegments;
  const patch=value=>setForm(current=>({...current,...value}));
  const insertVariable=name=>patch({body:`${form.body}${form.body&&!/\s$/.test(form.body)?' ':''}{{${name}}}`});
  function insertEmoji(emoji){
    const field=bodyRef.current,start=field?.selectionStart??form.body.length,end=field?.selectionEnd??form.body.length;
    const value=form.body.slice(0,start)+emoji+form.body.slice(end);
    if(value.length>1600)return;
    patch({body:value});emojiInserted.current=true;setEmojiOpen(false);
    requestAnimationFrame(()=>{field?.focus();field?.setSelectionRange(start+emoji.length,start+emoji.length);});
  }
  async function save(extra={}){
    setBusy(true);setError('');
    try{
      const result=await api({},{action:'save_template',...(selected?{id:selected.id,version:selected.version}:{}),...form,...extra});
      notify({title:selected?'Template updated':'Template created',variant:'success'});
      await load();if(result.result?.id)setSelectedId(result.result.id);
    }catch(e){setError(e.message);notify({title:'Template save failed',description:e.message,variant:'error'});}finally{setBusy(false);}
  }
  async function duplicate(){
    if(!selected)return;
    setSelectedId('');setForm({...formFromRow(selected),name:`${selected.name} copy`,status:'active'});
  }
  async function archive(){
    if(!selected)return;
    setBusy(true);
    try{await api({},{action:'archive_template',id:selected.id});notify({title:'Template archived',variant:'success'});await load();}
    catch(e){notify({title:'Archive failed',description:e.message,variant:'error'});}finally{setBusy(false);}
  }
  async function remove(){
    if(!selected||!window.confirm(`Delete template “${selected.name}”? Campaigns that already used it keep their history.`))return;
    setBusy(true);
    try{await api({},{action:'delete_template',id:selected.id});notify({title:'Template deleted',variant:'success'});setSelectedId('');await load();}
    catch(e){notify({title:'Delete failed',description:e.message,variant:'error'});}finally{setBusy(false);}
  }
  const missingSamples=variables.filter(v=>!String(form.sample_values?.[v]||'').trim());
  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_390px]" data-testid="sms-templates">
    <div className="space-y-4">
      {error&&<p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}
      <Card><CardHeader className="flex flex-row items-center justify-between"><div><CardTitle className="flex items-center gap-2"><LayoutTemplate className="size-4 text-sky-600"/>SMS templates</CardTitle><p className="mt-1 text-xs text-muted-foreground">Outbound campaigns send one template per campaign. Variables such as {'{{first_name}}'} are mapped to contact-list fields in the campaign editor.</p></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy||loading} onClick={()=>void load()}><RefreshCw className={`mr-1 size-3.5 ${loading?'animate-spin':''}`}/>Refresh</Button><Button size="sm" disabled={busy} onClick={()=>{setSelectedId('');setForm({...EMPTY_SMS_TEMPLATE});}}><Plus className="mr-1 size-3.5"/>New</Button></div></CardHeader>
        <CardContent className="space-y-3">
          <Field label="Template"><Select value={selectedId||'__new__'} onValueChange={value=>setSelectedId(value==='__new__'?'':value)}><SelectTrigger className="h-auto min-h-11 w-full py-2" data-testid="sms-template-select"><SelectValue placeholder="Select a template to edit"/></SelectTrigger>
            <SelectContent className="max-h-96"><SelectItem value="__new__" className="py-2.5">New template</SelectItem>{templates.map(t=><SelectItem key={t.id} value={t.id} textValue={`${t.name} ${t.category} ${t.language} ${t.status}`} className="py-2.5"><span className="flex min-w-0 items-center gap-3"><span className="min-w-0 flex-1"><span className="block truncate font-medium">{t.name}</span><span className="block truncate text-xs text-muted-foreground">{t.language} · {t.category} · {(t.variables||[]).length} variable{(t.variables||[]).length===1?'':'s'}{t.campaign_count?` · ${t.campaign_count} campaign${t.campaign_count===1?'':'s'}`:''}</span></span><Badge variant="outline" className={statusClass(t.status)}>{t.status}</Badge></span></SelectItem>)}</SelectContent></Select></Field>
          <p className="text-[10px] text-muted-foreground" data-testid="sms-template-count">{loading?'Loading templates…':templates.length?`${templates.length} template${templates.length===1?'':'s'} · ${templates.filter(t=>t.status==='active').length} active.`:'No templates yet. Create the first one below.'}</p>
        </CardContent></Card>
      <Card><CardHeader><CardTitle>{selected?`Edit “${selected.name}”`:'Create a template'}</CardTitle><p className="text-xs text-muted-foreground">Plain text with {'{{variable}}'} placeholders. The opt-out footer from Dialer → Settings → Messaging is appended when the template inherits it.</p></CardHeader><CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Name"><Input value={form.name} maxLength={120} onChange={e=>patch({name:e.target.value})} placeholder="Appointment reminder" data-testid="sms-template-name"/></Field>
          <Field label="Category"><Select value={form.category} onValueChange={value=>patch({category:value})}><SelectTrigger className="w-full" data-testid="sms-template-category"><SelectValue/></SelectTrigger><SelectContent>{SMS_TEMPLATE_CATEGORIES.map(c=><SelectItem key={c} value={c}>{c.replace(/^\w/,ch=>ch.toUpperCase())}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Language" hint="A label that helps you pick the right template; campaigns send the one template you select and never switch it per contact."><TemplateLanguagePicker id="sms-template-language" value={form.language} onChange={value=>patch({language:value})} disabled={busy} data-testid="sms-template-language"/></Field>
          <Field label="Opt-out footer"><Select value={form.footer_mode} onValueChange={value=>patch({footer_mode:value})}><SelectTrigger className="w-full" data-testid="sms-template-footer"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="inherit">Append footer</SelectItem><SelectItem value="none">No footer</SelectItem></SelectContent></Select></Field>
        </div>
        <Field label="Message text"><Textarea ref={bodyRef} rows={6} value={form.body} maxLength={1600} onChange={e=>patch({body:e.target.value})} placeholder="Hi {{first_name}}, your order {{order_id}} is ready for pickup." data-testid="sms-template-body"/></Field>
        <div className="flex items-center gap-2">
          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
            <PopoverTrigger asChild><Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 rounded-lg text-xs text-muted-foreground" aria-label="Emoji" data-testid="sms-template-emoji"><Smile className="size-4"/>Emoji</Button></PopoverTrigger>
            <PopoverContent side="top" align="start" sideOffset={8} collisionPadding={12} className="w-auto max-w-[calc(100vw-1.5rem)] p-2" aria-label="Choose emoji"
              onCloseAutoFocus={event=>{if(emojiInserted.current){event.preventDefault();emojiInserted.current=false;bodyRef.current?.focus();}}}>
              <EmojiPickerPanel onEmojiSelect={insertEmoji}/>
            </PopoverContent>
          </Popover>
          <span className="text-[10px] text-muted-foreground">Emoji are inserted at the cursor and switch the message to UCS-2 (70 characters per part).</span>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground"><span className="mr-1">Insert variable:</span>{[...CONTACT_VARIABLES,...SYSTEM_VARIABLES.filter(v=>v.key!=='unsubscribe_url').map(v=>v.key)].map(name=><button key={name} type="button" className="rounded-full border px-2 py-0.5 font-mono hover:bg-muted" onClick={()=>insertVariable(name)}>{`{{${name}}}`}</button>)}</div>
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2 text-xs"><span data-testid="sms-template-segments">{describeSmsSegments(preview.segments)} · {preview.segments.chars} characters{preview.footer?' incl. footer':''}</span>{preview.segments.encoding==='UCS-2'&&<span className="text-amber-700 dark:text-amber-300">Non-GSM characters switch the message to UCS-2 (70 characters per part).</span>}{tooManyParts&&<span className="text-destructive" data-testid="sms-template-too-long">Too long: shorten to at most {maxSegments} part{maxSegments===1?'':'s'}, the limit set in Dialer &rarr; Settings &rarr; Messaging.</span>}</div>
        {variables.length>0&&<div className="space-y-2"><p className="text-xs font-medium">Sample values <span className="font-normal text-muted-foreground">(used for this preview only)</span></p><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{variables.map(name=><Field key={name} label={`{{${name}}}`}><Input value={form.sample_values?.[name]||''} onChange={e=>patch({sample_values:{...form.sample_values,[name]:e.target.value}})} data-testid={`sms-template-sample-${name}`}/></Field>)}</div>{missingSamples.length>0&&<p className="text-[10px] text-muted-foreground">Variables without a sample stay as placeholders in the preview.</p>}</div>}
        <div className="space-y-2 rounded-lg border bg-muted/20 p-3" data-testid="sms-template-footer-policy">
          {form.footer_mode==='inherit'?<>
            <Field label="Footer text" hint={policy.text?`Leave empty to keep the workspace footer from Dialer → Settings → Messaging (“${policy.text}”).`:'No workspace footer is configured, so only the text entered here is appended.'}>
              <Input value={form.footer_text||''} maxLength={SMS_FOOTER_MAX_CHARS} placeholder={policy.text||'Reply STOP to opt out'} onChange={e=>patch({footer_text:e.target.value})} data-testid="sms-template-footer-text"/>
            </Field>
            {!preview.footer&&<p className="text-[10px] text-amber-700 dark:text-amber-300">No footer is configured, so nothing is appended to this template.</p>}
          </>:preview.footerReason==='required'
            ? <p className="text-[11px] text-amber-700 dark:text-amber-300" data-testid="sms-template-footer-required">Dialer → Settings → Messaging requires an opt-out footer, so “{preview.footer}” is still appended. Turn off <span className="font-medium">Require opt-out footer</span> there to send without it.</p>
            : <p className="text-[11px] text-muted-foreground" data-testid="sms-template-footer-off">No opt-out footer is appended to this template.</p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          {selected&&<Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={()=>void remove()}><Trash2 className="mr-1 size-3.5"/>Delete</Button>}
          {selected&&selected.status==='active'&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void archive()}><Archive className="mr-1 size-3.5"/>Archive</Button>}
          {selected&&selected.status==='archived'&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void save({status:'active'})}>Restore</Button>}
          {selected&&<Button size="sm" variant="outline" disabled={busy} onClick={()=>void duplicate()}><Copy className="mr-1 size-3.5"/>Duplicate</Button>}
          <Button size="sm" disabled={busy||!form.name.trim()||!form.body.trim()||tooManyParts} onClick={()=>void save()} data-testid="sms-template-save">{selected?<Save className="mr-1 size-3.5"/>:<Plus className="mr-1 size-3.5"/>}{selected?'Update':'Create'}</Button>
        </div>
      </CardContent></Card>
      <Card><CardHeader><CardTitle>All templates</CardTitle></CardHeader><CardContent><div className="overflow-auto rounded-xl border"><table className="w-full text-left text-xs"><thead className="bg-muted/50"><tr><th className="p-3 font-medium">Name</th><th className="p-3 font-medium">Category</th><th className="p-3 font-medium">Language</th><th className="p-3 font-medium">Variables</th><th className="p-3 font-medium">Campaigns</th><th className="p-3 font-medium">Status</th></tr></thead><tbody>{templates.map(t=><tr key={t.id} className="cursor-pointer border-t hover:bg-muted/30" onClick={()=>setSelectedId(t.id)} data-testid="sms-template-row"><td className="p-3 font-medium">{t.name}</td><td className="p-3">{t.category}</td><td className="p-3">{t.language}</td><td className="max-w-80 break-words p-3 font-mono">{(t.variables||[]).join(', ')||'—'}</td><td className="p-3">{t.campaign_count||0}</td><td className="p-3"><Badge variant="outline" className={statusClass(t.status)}>{t.status}</Badge></td></tr>)}{!templates.length&&!loading&&<tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No templates to display.</td></tr>}</tbody></table></div></CardContent></Card>
    </div>
    <div className="xl:sticky xl:top-3 xl:self-start"><SmsPhonePreview contactName="Template preview" senderLabel="your campaign number" messages={form.body?[{direction:'outbound',text:preview.text,status:'delivered'}]:[]}/></div>
  </div>;
}
