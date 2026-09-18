"use client";
import { useCallback,useEffect,useMemo,useState } from 'react';
import { LayoutTemplate,Plus,RefreshCw,Save,Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@/components/ui/select';
import { notify } from '@/components/ToastNotify';
import WhatsAppPhonePreview from './WhatsAppPhonePreview';
import WhatsAppTemplateLanguagePicker from './WhatsAppTemplateLanguagePicker';
import { api,rowsOf,Field,Loading,StatusBadge } from './whatsapp-admin-shared';
import { buildTemplateDefinitionComponents,templateFormFromDefinition,templateVariableIndexes,validateTemplateDefinitionComponents,EMPTY_TEMPLATE_FORM,
  WHATSAPP_TEMPLATE_CATEGORIES,WHATSAPP_TEMPLATE_HEADER_FORMATS,WHATSAPP_TEMPLATE_BUTTON_TYPES } from '@/lib/whatsapp/templates.mjs';

const templateWaba=template=>String(template?.whatsapp_business_account?.waba_id||template?.whatsapp_business_account?.id||template?.waba_id||'');
const statusClass=status=>{const value=String(status||'').toUpperCase();return value==='APPROVED'?'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300':value==='REJECTED'?'border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300':'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300';};

// Message templates on the resolved Telnyx account: list, create, edit and delete
// with the demo-portal phone preview. Every template belongs to one WhatsApp
// Business Account; the WABA picker scopes the list and new submissions.
export default function WhatsAppTemplatesSection({account,accounts=[],busy,setBusy}){
  const [templates,setTemplates]=useState([]),[loading,setLoading]=useState(true),[selectedId,setSelectedId]=useState(''),[form,setForm]=useState({...EMPTY_TEMPLATE_FORM}),[error,setError]=useState('');
  const [wabaChoice,setWabaChoice]=useState('');
  const load=useCallback(async()=>{
    setLoading(true);setError('');
    try{setTemplates(rowsOf(await api({resource:'templates'})));}
    catch(e){setError(e.message);}finally{setLoading(false);}
  },[]);
  useEffect(()=>{void load();},[load]);
  const wabaOptions=useMemo(()=>{
    const counts=new Map();for(const t of templates){const id=templateWaba(t);counts.set(id,(counts.get(id)||0)+1);}
    const known=new Map(accounts.map(a=>[a.wabaId,a]));
    return [...new Set([...accounts.map(a=>a.wabaId),...counts.keys()])].filter(Boolean).map(id=>({id,name:known.get(id)?.name||'WhatsApp Business Account',count:counts.get(id)||0,phoneNumbers:known.get(id)?.phoneNumbersCount||0}));
  },[templates,accounts]);
  // Default to the account chosen under Details when it has templates, otherwise the busiest account.
  const wabaId=wabaChoice||(wabaOptions.find(o=>o.id===account?.wabaId&&o.count)||[...wabaOptions].sort((a,b)=>b.count-a.count||b.phoneNumbers-a.phoneNumbers)[0])?.id||account?.wabaId||'';
  const visible=useMemo(()=>templates.filter(t=>!wabaId||templateWaba(t)===wabaId),[templates,wabaId]);
  const selected=visible.find(t=>t.id===selectedId)||null;
  useEffect(()=>{setForm(selected?templateFormFromDefinition(selected):{...EMPTY_TEMPLATE_FORM});},[selected]);
  const components=useMemo(()=>{try{return buildTemplateDefinitionComponents(form);}catch{return [];}},[form]);
  const validation=useMemo(()=>validateTemplateDefinitionComponents(components,form.category),[components,form.category]);
  const variables=useMemo(()=>[...templateVariableIndexes(form.headerFormat==='TEXT'?form.headerText:'').map(i=>`header:${i}`),...templateVariableIndexes(form.bodyText).map(i=>`body:${i}`),
    ...(form.buttons||[]).map((b,i)=>b.type==='URL'&&String(b.url).includes('{{')?`button:${i}`:null).filter(Boolean)],[form]);
  const patch=value=>setForm(current=>({...current,...value}));
  async function save(){
    if(validation.length){setError(validation.join(' '));return;}
    setBusy(true);setError('');
    try{
      const result=await api({},selected?{action:'save_template',id:selected.id,category:form.category,components}:{action:'save_template',name:form.name,wabaId,category:form.category,language:form.language,components});
      notify({title:selected?'Template updated':'Template submitted for review',description:selected?undefined:'Meta reviews new templates before they can be sent.',variant:'success'});
      await load();if(result.result?.id)setSelectedId(result.result.id);
    }catch(e){setError(e.message);notify({title:'Template action failed',description:e.message,variant:'error'});}finally{setBusy(false);}
  }
  async function remove(){
    if(!selected||!window.confirm(`Delete template “${selected.name}” from Meta? This cannot be undone.`))return;
    setBusy(true);try{await api({},{action:'delete_template',id:selected.id});notify({title:'Template deleted',variant:'success'});setSelectedId('');await load();}
    catch(e){notify({title:'Delete failed',description:e.message,variant:'error'});}finally{setBusy(false);}
  }
  const authentication=form.category==='AUTHENTICATION';
  const previewMessage={direction:'outbound',status:'read',kind:'template',template:{name:form.name||selected?.name||'new_template',category:form.category,components},values:form.variableExamples||{}};
  return <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_390px]" data-testid="whatsapp-templates">
    <div className="space-y-4">
      {error&&<p role="alert" className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}
      <Card><CardHeader className="flex flex-row items-center justify-between"><div><CardTitle className="flex items-center gap-2"><LayoutTemplate className="size-4 text-green-600"/>Message templates</CardTitle><p className="mt-1 text-xs text-muted-foreground">Approved templates can be sent when the 24-hour window is closed. Meta reviews every submission.</p></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy||loading} onClick={()=>void load()}><RefreshCw className={`mr-1 size-3.5 ${loading?'animate-spin':''}`}/>Refresh</Button><Button size="sm" disabled={busy} onClick={()=>setSelectedId('')}><Plus className="mr-1 size-3.5"/>New</Button></div></CardHeader>
        <CardContent className="space-y-3">{loading?<Loading label="Loading templates"/>:<>
          {wabaOptions.length>1&&<Field label="WhatsApp Business Account"><Select value={wabaId} onValueChange={value=>{setWabaChoice(value);setSelectedId('');}}><SelectTrigger className="w-full" data-testid="whatsapp-template-waba"><SelectValue placeholder="Select account"/></SelectTrigger>
            <SelectContent>{wabaOptions.map(o=><SelectItem key={o.id} value={o.id}>{o.name} · {o.id} · {o.count} template{o.count===1?'':'s'}</SelectItem>)}</SelectContent></Select></Field>}
          <Field label="Template"><Select value={selectedId||'__new__'} onValueChange={value=>setSelectedId(value==='__new__'?'':value)}><SelectTrigger className="h-auto min-h-11 w-full py-2" data-testid="whatsapp-template-select"><SelectValue placeholder="Select a template to edit"/></SelectTrigger>
            <SelectContent className="max-h-96"><SelectItem value="__new__" className="py-2.5">New template</SelectItem>{visible.map(t=><SelectItem key={t.id} value={t.id} textValue={`${t.name} ${t.language} ${t.category} ${t.status}`} className="py-2.5"><span className="flex min-w-0 items-center gap-3"><span className="min-w-0 flex-1"><span className="block truncate font-medium">{t.name}</span><span className="block truncate text-xs text-muted-foreground">{t.language} · {t.category}</span></span><Badge variant="outline" className={statusClass(t.status)}>{t.status}</Badge></span></SelectItem>)}</SelectContent></Select></Field>
          <p className="text-[10px] text-muted-foreground" data-testid="whatsapp-template-count">{visible.length?`${visible.length} template${visible.length===1?'':'s'} on ${wabaId||'the account'}.`:'No templates found on this account.'}{selected?.rejection_reason?` · Rejection reason: ${selected.rejection_reason}`:''}</p>
        </>}</CardContent></Card>
      <Card><CardHeader><CardTitle>{selected?`Edit “${selected.name}”`:'Create a template'}</CardTitle><p className="text-xs text-muted-foreground">Name and language are fixed after submission. Variables use the {'{{1}}'}, {'{{2}}'} placeholders in order.</p></CardHeader><CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Field label="Name"><Input value={form.name} disabled={Boolean(selected)} onChange={e=>patch({name:e.target.value.toLowerCase().replace(/[^a-z0-9_]/g,'_')})} placeholder="order_update"/></Field>
          <Field label="Category"><Select value={form.category} onValueChange={value=>patch({category:value})}><SelectTrigger className="w-full" data-testid="whatsapp-template-category"><SelectValue/></SelectTrigger><SelectContent>{WHATSAPP_TEMPLATE_CATEGORIES.map(c=><SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Language"><WhatsAppTemplateLanguagePicker value={form.language} disabled={Boolean(selected)} onChange={value=>patch({language:value})}/></Field>
          {!authentication&&<Field label="Header"><Select value={form.headerFormat} onValueChange={value=>patch({headerFormat:value})}><SelectTrigger className="w-full" data-testid="whatsapp-template-header"><SelectValue/></SelectTrigger><SelectContent>{WHATSAPP_TEMPLATE_HEADER_FORMATS.map(f=><SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent></Select></Field>}
        </div>
        {authentication?<div className="grid gap-3 rounded-xl border bg-muted/20 p-4 sm:grid-cols-2">
          <Field label="Copy-code button text"><Input value={form.authenticationCopyCodeText} onChange={e=>patch({authenticationCopyCodeText:e.target.value})}/></Field>
          <div className="space-y-3 pt-5"><label className="flex items-center gap-2 text-xs"><Switch checked={form.authenticationAddSecurityRecommendation} onCheckedChange={v=>patch({authenticationAddSecurityRecommendation:v})}/>Add the security recommendation</label>
            <label className="flex items-center gap-2 text-xs"><Switch checked={form.authenticationCodeExpirationEnabled} onCheckedChange={v=>patch({authenticationCodeExpirationEnabled:v})}/>Code expiration footer</label></div>
          {form.authenticationCodeExpirationEnabled&&<Field label="Expires after (minutes, 1–90)"><Input type="number" min="1" max="90" value={form.authenticationCodeExpirationMinutes} onChange={e=>patch({authenticationCodeExpirationMinutes:Number(e.target.value)})}/></Field>}
          <p className="text-[10px] text-muted-foreground sm:col-span-2">Authentication templates use Meta-generated body text. The OTP code is inserted as {'{{1}}'} when the template is sent.</p>
        </div>:<>
          {form.headerFormat==='TEXT'&&<Field label="Header text"><Input value={form.headerText} maxLength={60} onChange={e=>patch({headerText:e.target.value})} placeholder="Your order {{1}}"/></Field>}
          {['IMAGE','VIDEO','DOCUMENT'].includes(form.headerFormat)&&<Field label="Meta media handle" hint="Sample media handle returned by Meta's resumable upload; required for review."><Input value={form.headerMediaHandle} onChange={e=>patch({headerMediaHandle:e.target.value})} placeholder="4::aW1hZ2UvanBlZw==:ARZ..."/></Field>}
          <Field label="Body text"><Textarea rows={6} value={form.bodyText} maxLength={1024} onChange={e=>patch({bodyText:e.target.value})} placeholder="Hi {{1}}, your order {{2}} shipped."/><span className="block text-[10px] font-normal text-muted-foreground">Add variables with {'{{1}}'}, {'{{2}}'} and provide examples below.</span></Field>
          <Field label="Footer text"><Input value={form.footerText} maxLength={60} onChange={e=>patch({footerText:e.target.value})} placeholder="Optional footer"/></Field>
          {variables.length>0&&<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{variables.map(key=><Field key={key} label={`${key.replace(/^(\w)/,c=>c.toUpperCase()).replace(/:(\d+)$/,' {{$1}}')} example`}><Input value={form.variableExamples?.[key]||''} onChange={e=>patch({variableExamples:{...form.variableExamples,[key]:e.target.value}})}/></Field>)}</div>}
          <div className="space-y-2"><div className="flex items-center justify-between"><div><p className="text-xs font-medium">Buttons</p><p className="text-[10px] text-muted-foreground">Quick reply, URL or phone buttons.</p></div><Button type="button" size="sm" variant="outline" disabled={(form.buttons||[]).length>=10} onClick={()=>patch({buttons:[...(form.buttons||[]),{type:'QUICK_REPLY',text:'',url:'',phoneNumber:''}]})}><Plus className="mr-1 size-3.5"/>Add button</Button></div>
            {(form.buttons||[]).map((button,index)=><div key={index} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[160px_1fr_1fr_auto]">
              <Select value={button.type} onValueChange={value=>patch({buttons:form.buttons.map((b,i)=>i===index?{...b,type:value}:b)})}><SelectTrigger className="w-full" aria-label="Button type"><SelectValue/></SelectTrigger><SelectContent>{WHATSAPP_TEMPLATE_BUTTON_TYPES.map(t=><SelectItem key={t} value={t}>{t.replace('_',' ')}</SelectItem>)}</SelectContent></Select>
              <Input placeholder="Button text" maxLength={25} value={button.text} onChange={e=>patch({buttons:form.buttons.map((b,i)=>i===index?{...b,text:e.target.value}:b)})}/>
              {button.type==='URL'?<Input placeholder="https://example.com/track/{{1}}" value={button.url} onChange={e=>patch({buttons:form.buttons.map((b,i)=>i===index?{...b,url:e.target.value}:b)})}/>:button.type==='PHONE_NUMBER'?<Input placeholder="+15551234567" value={button.phoneNumber} onChange={e=>patch({buttons:form.buttons.map((b,i)=>i===index?{...b,phoneNumber:e.target.value}:b)})}/>:<span className="self-center text-[10px] text-muted-foreground">Quick reply</span>}
              <Button type="button" size="icon" variant="ghost" aria-label="Remove button" onClick={()=>patch({buttons:form.buttons.filter((_,i)=>i!==index)})}><Trash2 className="size-4"/></Button>
            </div>)}</div>
        </>}
        {validation.length>0&&<ul className="list-disc space-y-1 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 pl-6 text-xs text-amber-800 dark:text-amber-300">{validation.map(v=><li key={v}>{v}</li>)}</ul>}
        <div className="flex flex-wrap justify-end gap-2">{selected&&<Button size="sm" variant="ghost" className="text-destructive" disabled={busy} onClick={()=>void remove()}><Trash2 className="mr-1 size-3.5"/>Delete</Button>}<Button size="sm" disabled={busy||!wabaId||(!selected&&!form.name)} onClick={()=>void save()}>{selected?<Save className="mr-1 size-3.5"/>:<Plus className="mr-1 size-3.5"/>}{selected?'Update':'Create'}</Button></div>
      </CardContent></Card>
    </div>
    <div className="xl:sticky xl:top-3 xl:self-start"><WhatsAppPhonePreview contactName="Template preview" messages={[previewMessage]}/></div>
  </div>;
}
