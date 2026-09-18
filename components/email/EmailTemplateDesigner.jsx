"use client";

import { useEffect,useRef,useState } from 'react';
import { Copy,Plus,RefreshCw,Save,Sparkles } from 'lucide-react';
import AIModels from '@/components/assistants/AIModels';
import { notify } from '@/components/ToastNotify';
import { Button } from '@/components/ui/button';
import { Card,CardContent,CardHeader,CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { emailHtmlText } from '@/lib/email/content.mjs';
import { RichEmailEditor } from './RichEmailEditor';
import { sanitizeEmailTemplateHtml } from './template-html';

const EMPTY={name:'',subject:'',html_body:'',text_body:''};
const API='/api/admin/email/template-ai';
async function request(options){
  const response=await fetch(API,{cache:'no-store',...options});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'Template AI is unavailable');
  return data;
}
function FormatPicker({value,onChange,disabled,label,htmlLabel='HTML'}){
  return <div role="group" aria-label={label} className="grid grid-cols-2 gap-1 rounded-lg border bg-muted/30 p-1">{[['html',htmlLabel],['plain','Plain text']].map(([id,title])=><Button key={id} type="button" size="sm" variant={value===id?'secondary':'ghost'} aria-pressed={value===id} disabled={disabled} onClick={()=>onChange(id)}>{title}</Button>)}</div>;
}
function TemplateWizard({value,onApply,disabled}){
  const [models,setModels]=useState([]),[model,setModel]=useState(''),[loading,setLoading]=useState(true),[catalogError,setCatalogError]=useState(''),[revision,setRevision]=useState(0);
  const [prompt,setPrompt]=useState(''),[format,setFormat]=useState('html'),[generating,setGenerating]=useState(false),[result,setResult]=useState(null);
  const generation=useRef(null);
  useEffect(()=>{
    const controller=new AbortController();
    request({signal:controller.signal}).then(data=>{
      if(controller.signal.aborted)return;
      const options=data.models||[];setModels(options);
      setModel(current=>options.some(m=>m.id===current)?current:options.find(m=>m.id==='Qwen/Qwen3-235B-A22B')?.id||options[0]?.id||'');
      setCatalogError(options.length?'':'No text generation models are available.');
    }).catch(error=>{if(!controller.signal.aborted)setCatalogError(error.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[revision]);
  useEffect(()=>()=>generation.current?.abort(),[]);
  async function generate(){
    const controller=new AbortController();generation.current=controller;
    const timeout=setTimeout(()=>controller.abort('timeout'),65000);
    setGenerating(true);setResult(null);
    try{
      const data=await request({method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({prompt,format,model,template:Object.fromEntries(Object.keys(EMPTY).map(key=>[key,value[key]||'']))})});
      if(controller.signal.aborted)return;
      setResult({...data.result,format:data.format});notify({title:'Template proposal generated',variant:'success'});
    }catch(error){if(!controller.signal.aborted||controller.signal.reason==='timeout')notify({title:'Template generation failed',description:controller.signal.reason==='timeout'?'Generation timed out. Try again.':error.message,variant:'error'});}
    finally{clearTimeout(timeout);if(generation.current===controller&&!controller.signal.aborted)setGenerating(false);if(controller.signal.reason==='timeout')setGenerating(false);}
  }
  return <aside aria-label="Template AI Wizard" className="min-h-0 min-w-0" data-testid="email-template-wizard">
    <Card className="flex h-full min-h-0 flex-col gap-0 overflow-hidden">
      <CardHeader className="shrink-0 border-b bg-violet-500/10 py-4"><div className="flex items-center gap-3"><span className="rounded-xl bg-violet-500/15 p-2 text-violet-700 dark:text-violet-300"><Sparkles className="size-5"/></span><div><CardTitle className="text-base">Template AI Wizard</CardTitle><p className="mt-1 text-xs text-muted-foreground">Describe layout, content and Liquid variables.</p></div></div></CardHeader>
      <CardContent className="min-h-0 space-y-5 pt-5 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain">
        <div className="space-y-2"><div className="flex items-center justify-between"><Label htmlFor="template-ai-model">AI model</Label><Button type="button" variant="ghost" size="icon" className="size-7" aria-label="Refresh template AI models" disabled={loading||generating} onClick={()=>{setLoading(true);setCatalogError('');setRevision(n=>n+1);}}><RefreshCw className={`size-3.5 ${loading?'animate-spin':''}`}/></Button></div>
          {loading?<div role="status" aria-label="Loading template AI models"><Skeleton className="h-10 w-full"/></div>:<AIModels id="template-ai-model" value={model} onValueChange={setModel} models={models} disabled={disabled||generating||Boolean(catalogError)} triggerClassName="border bg-background" contentClassName="max-w-[calc(100vw-32px)]" emptyMessage="No text generation models found."/>}
          {catalogError&&<p role="alert" className="text-xs text-destructive">{catalogError}</p>}
        </div>
        <div className="space-y-2"><Label htmlFor="template-ai-requirements">Template requirements</Label><Textarea id="template-ai-requirements" value={prompt} onChange={e=>setPrompt(e.target.value)} disabled={disabled||generating} maxLength={4000} className="min-h-40 resize-y" placeholder="Create a welcome email with a green button, a short security note and {{ activation_url }}…"/><p className="text-right text-[10px] text-muted-foreground">{prompt.length}/4000</p></div>
        <div className="space-y-2"><Label>Generate as</Label><FormatPicker label="Generated template format" value={format} onChange={next=>{setFormat(next);setResult(null);}} disabled={disabled||generating}/></div>
        <Button type="button" className="w-full" disabled={disabled||generating||loading||Boolean(catalogError)||!model||!prompt.trim()} onClick={generate}><Sparkles className="mr-2 size-4"/>{generating?'Generating…':'Generate template'}</Button>
        {generating&&<div role="status" aria-label="Generating email template" className="space-y-3 rounded-xl border p-4"><Skeleton className="h-5 w-3/4"/>{[0,1,2].map(i=><Skeleton key={i} className="h-12 w-full"/>)}</div>}
        {result&&<section className="overflow-hidden rounded-xl border" aria-label="Generated template"><div className="flex items-center justify-between gap-2 border-b bg-muted/30 p-3"><div><p className="text-sm font-medium">Generated template</p><p className="text-xs text-muted-foreground">{result.format==='html'?'HTML':'Plain text'}</p></div><Button type="button" variant="ghost" size="icon" aria-label="Copy generated template" onClick={async()=>{try{await navigator.clipboard.writeText(result.text_body);notify({title:'AI result copied',variant:'success'});}catch{notify({title:'Could not copy the AI result',variant:'error'});}}}><Copy className="size-4"/></Button></div><div className="max-h-64 space-y-3 overflow-y-auto p-3"><p className="break-words text-sm font-semibold">{result.subject}</p><p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{result.text_body}</p></div><div className="border-t p-3"><Button type="button" className="w-full" disabled={disabled} onClick={()=>{onApply(result);notify({title:'AI content applied to the template',variant:'success'});}}>Apply to template</Button></div></section>}
        <p className="text-xs leading-relaxed text-muted-foreground">Review the proposal, apply it to the editor, then save your template.</p>
      </CardContent>
    </Card>
  </aside>;
}

export default function EmailTemplateDesigner({value,onChange,onSave,onNew,onCancel,loading,disabled,contextKey,children}){
  const draft={...value,...Object.fromEntries(Object.keys(EMPTY).map(key=>[key,value?.[key]||'']))};
  const [mode,setMode]=useState(()=>value?.id&&!value.html_body?'plain':'html');
  function update(patch){onChange(current=>({...EMPTY,...current,...patch}));}
  return <div className="grid min-h-0 min-w-0 shrink-0 gap-5 lg:flex-1 lg:shrink lg:grid-cols-[minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_360px]" data-testid="email-template-designer">
    <Card className="flex min-h-0 min-w-0 flex-col overflow-hidden"><CardHeader className="flex shrink-0 flex-row items-center justify-between"><CardTitle>Email templates</CardTitle><Button type="button" size="sm" disabled={disabled} onClick={onNew}><Plus className="mr-1 size-4"/>New template</Button></CardHeader><CardContent className="min-h-0 space-y-5 lg:flex-1 lg:overflow-y-auto lg:overscroll-contain"><p className="text-xs text-muted-foreground">Templates are shared across the Telnyx account. Agents can insert a template into their draft and review it before sending.</p>{children}
      {loading?<div role="status" aria-label="Loading template" className="space-y-4"><Skeleton className="h-10 w-full"/><Skeleton className="h-10 w-full"/><Skeleton className="h-80 w-full"/></div>:<form className="space-y-4" aria-label="Email template editor" onSubmit={async event=>{event.preventDefault();const html=mode==='html'?sanitizeEmailTemplateHtml(draft.html_body):'';await onSave({...draft,html_body:html,text_body:mode==='html'?(draft.text_body.trim()?draft.text_body:emailHtmlText(html)):draft.text_body});}}>
        <div className="grid gap-3 xl:grid-cols-2"><div className="space-y-2"><Label htmlFor="email-template-name">Template name</Label><Input id="email-template-name" required maxLength={120} value={draft.name} disabled={disabled} onChange={e=>update({name:e.target.value})} placeholder="account-welcome"/></div><div className="space-y-2"><Label htmlFor="email-template-subject">Subject</Label><Input id="email-template-subject" required maxLength={998} value={draft.subject} disabled={disabled} onChange={e=>update({subject:e.target.value})} placeholder="Welcome, {{ first_name }}"/></div></div>
        <div className="space-y-2"><FormatPicker label="Template editor format" value={mode} onChange={next=>{if(next==='plain'&&draft.html_body&&!draft.text_body.trim())update({text_body:emailHtmlText(draft.html_body)});setMode(next);}} disabled={disabled} htmlLabel="Visual HTML"/><p className="text-xs text-muted-foreground">Liquid variables supported: {'{{ variable_name }}'}</p></div>
        {mode==='html'?<RichEmailEditor value={draft.html_body} onChange={html_body=>update({html_body})} sanitizeHtml={sanitizeEmailTemplateHtml} placeholder="Design the email template…" minHeight={360} disabled={disabled}/>:<Textarea aria-label="Plain text template" value={draft.text_body} onChange={e=>update({text_body:e.target.value})} className="min-h-96 resize-y font-mono" disabled={disabled} placeholder="Hello {{ first_name }},"/>}
        <div className="flex gap-2"><Button disabled={disabled||!draft.name.trim()||!draft.subject.trim()||!(mode==='html'?draft.html_body:draft.text_body).trim()}><Save className="mr-2 size-4"/>Save template</Button><Button type="button" variant="ghost" disabled={disabled} onClick={onCancel}>Cancel</Button></div>
      </form>}
    </CardContent></Card>
    <TemplateWizard key={contextKey} value={draft} disabled={disabled||loading} onApply={result=>{update({name:draft.name||result.name,subject:result.subject,html_body:result.format==='html'?sanitizeEmailTemplateHtml(result.html_body):'',text_body:result.text_body});setMode(result.format);}}/>
  </div>;
}
