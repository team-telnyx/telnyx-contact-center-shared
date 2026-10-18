"use client";
import { useUiText } from "@/components/i18n/use-ui-text";

import { useEffect, useRef, useState } from 'react';
import { FlaskConical, Play, RotateCcw, LoaderCircle, CheckCircle2, AlertTriangle, MapPin } from 'lucide-react';
import AIModels from '@/components/assistants/AIModels';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';

async function jsonRequest(path,options={}){
 const response=await fetch(path,{cache:'no-store',...options});
 const data=await response.json();
 if(!response.ok)throw Error(data.error||'AI preview unavailable.');
 return data;
}
function JsonBlock({value}){return <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl border bg-muted/30 p-3 font-mono text-xs leading-relaxed">{typeof value==='string'?value:JSON.stringify(value,null,2)}</pre>;}

export default function AiOperationLab({operation,config,copilot,models,canTest}){
  const tUi = useUiText();
 const [open,setOpen]=useState(false);
 return <><Button variant="outline" className="w-full" onClick={()=>setOpen(true)}><FlaskConical className="mr-2 size-4"/>{tUi("Full prompt & test lab")}</Button>
  <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-6xl">
   <DialogHeader><DialogTitle>{operation.title}{tUi(" · Prompt & test lab")}</DialogTitle><DialogDescription>{tUi("Inspect the full instructions and test the current draft without saving it.")}</DialogDescription></DialogHeader>
   {open&&<LabContent key={operation.id} {...{operation,config,copilot,models,canTest}}/>}
  </DialogContent></Dialog></>;
}
function LabContent({operation,config,copilot,models,canTest}){
  const tUi = useUiText();
 const [sample,setSample]=useState(''),[initialSample,setInitialSample]=useState(''),[model,setModel]=useState('');
 const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[reload,setReload]=useState(0);
 const [preview,setPreview]=useState(null),[previewError,setPreviewError]=useState(''),[previewKey,setPreviewKey]=useState('');
 const [running,setRunning]=useState(false),[result,setResult]=useState(null),[runError,setRunError]=useState('');
 const testController=useRef(null);
 let input=null,inputError='';
 try{if(sample)input={id:operation.id,config,model,sample:JSON.parse(sample),...(copilot?{copilot}:{})};}catch{inputError='Sample data must be valid JSON.';}
 const inputKey=input?JSON.stringify(input):'';
 useEffect(()=>{
  const controller=new AbortController();
  setLoading(true);setLoadError('');
  jsonRequest(`/api/admin/ai-operations/preview?id=${encodeURIComponent(operation.id)}`,{signal:controller.signal})
   .then(data=>{const text=JSON.stringify(data.sample,null,2);setSample(text);setInitialSample(text);})
   .catch(error=>{if(!controller.signal.aborted)setLoadError(error.message);})
   .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
  return()=>controller.abort();
 },[operation.id,reload]);
 useEffect(()=>{
  if(!inputKey)return;
  const controller=new AbortController();
  const timer=setTimeout(()=>{
   jsonRequest('/api/admin/ai-operations/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:inputKey,signal:controller.signal})
    .then(data=>{setPreview(data);setPreviewKey(inputKey);setPreviewError('');})
    .catch(error=>{if(!controller.signal.aborted){setPreviewError(error.message);setPreviewKey(inputKey);setPreview(null);}});
  },250);
  return()=>{clearTimeout(timer);controller.abort();};
 },[inputKey]);
 useEffect(()=>()=>testController.current?.abort(),[]);
 const fresh=previewKey===inputKey;
 async function run(){
  const controller=new AbortController();testController.current=controller;setRunning(true);setRunError('');setResult(null);
  try{const data=await jsonRequest('/api/admin/ai-operations/test',{method:'POST',headers:{'Content-Type':'application/json'},body:inputKey,signal:controller.signal});if(!controller.signal.aborted)setResult({...data,inputKey});}
  catch(error){if(!controller.signal.aborted)setRunError(error.message);}
  finally{if(!controller.signal.aborted)setRunning(false);}
 }
 if(loading)return <div role="status" aria-label={tUi("Loading prompt examples")} className="grid gap-4 md:grid-cols-2"><Skeleton className="h-96"/><Skeleton className="h-96"/></div>;
 if(loadError)return <div role="alert" className="space-y-3"><p>{loadError}</p><Button onClick={()=>setReload(x=>x+1)}>{tUi("Retry")}</Button></div>;
 const baseline=preview?.baseline,request=preview?.request;
 const parameters=request&&Object.fromEntries(Object.entries(request).filter(([key])=>key!=='messages'));
 return <div className="space-y-5">
  <div className="rounded-xl border bg-muted/30 p-4 text-sm"><div className="mb-2 flex items-center gap-2 font-medium"><MapPin className="size-4"/>{tUi("Where changes take effect")}</div><ul className="list-inside list-disc space-y-1 text-muted-foreground">{operation.usage?.screens.map(screen=><li key={screen}>{screen}</li>)}</ul><p className="mt-2 text-xs text-muted-foreground">{operation.usage?.context}</p></div>
  <div className="grid gap-5 lg:grid-cols-2">
   <section className="min-w-0 space-y-4">
    <div className="space-y-2"><Label>{tUi("Model for this test")}</Label><AIModels value={model} onValueChange={setModel} models={models} placeholder={tUi("Configured default · {value0}", { value0: fresh&&request?request.model:config.model||copilot?.model||operation.effective?.model||operation.inherited?.model||tUi("not set") })} disabled={running}/><p className="text-xs text-muted-foreground">{tUi("One-off override. Choosing a test model does not save a new default.")}</p></div>
    <div className="space-y-2"><div className="flex items-center justify-between gap-2"><Label htmlFor="ai-lab-sample">{tUi("Example context · JSON")}</Label><Button size="sm" variant="ghost" disabled={running} onClick={()=>{setSample(initialSample);setModel('');}}><RotateCcw className="mr-1 size-3"/>{tUi("Reset example")}</Button></div><Textarea id="ai-lab-sample" value={sample} onChange={event=>setSample(event.target.value)} disabled={running} maxLength={40000} rows={15} className="font-mono text-xs"/><p className="text-xs text-muted-foreground">{tUi("Starts with synthetic data. Run test sends this context and the current instructions to Telnyx. No messages, calls, form edits or evaluations are created.")}</p></div>
    <Button onClick={run} disabled={!canTest||running||!fresh||!request||!!inputError} className="w-full">{running?<LoaderCircle className="mr-2 size-4 animate-spin"/>:<Play className="mr-2 size-4"/>}{running?tUi("Testing…"):tUi("Run test with current draft")}</Button>
    {!canTest&&<p className="text-xs text-muted-foreground">{tUi("Testing requires System settings update permission. Prompt inspection is available in read-only mode.")}</p>}
    {(inputError||fresh&&previewError||runError)&&<p role="alert" className="text-sm text-destructive">{inputError||previewError||runError}</p>}
   </section>
   <section className="min-w-0 space-y-3">
    <h3 className="font-semibold">{tUi("Full instructions for this example")}</h3><p className="text-xs text-muted-foreground">{tUi("Generated by the same prompt builders used in the application. Live content varies with the workflow, scorecard and conversation. Protected technical rules on the settings card are only a summary.")}</p>
    {!fresh&&!inputError?<Skeleton className="h-80"/>:request&&fresh?<>
     <details open><summary className="mb-2 cursor-pointer text-sm font-medium">{tUi("Effective system instructions · current draft")}</summary><JsonBlock value={request.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n')}/></details>
     <details><summary className="mb-2 cursor-pointer text-sm font-medium">{tUi("Built-in instructions · before administrator guidance")}</summary><JsonBlock value={baseline.messages.filter(m=>m.role==='system').map(m=>m.content).join('\n\n')}/></details>
     <details><summary className="mb-2 cursor-pointer text-sm font-medium">{tUi("User messages & dynamic context")}</summary><JsonBlock value={request.messages.filter(m=>m.role!=='system')}/></details>
     <details><summary className="mb-2 cursor-pointer text-sm font-medium">{tUi("Request parameters & schemas")}</summary><JsonBlock value={parameters}/></details>
     {preview.note&&<p className="text-xs text-muted-foreground">{preview.note}</p>}
    </>:null}
   </section>
  </div>
  {result&&<section className="space-y-3 rounded-2xl border p-4" aria-label={tUi("AI test result")}><div className="flex flex-wrap items-center gap-2"><h3 className="mr-auto font-semibold">{tUi("Test result")}</h3><Badge variant="outline">{result.elapsedMs}{tUi(" ms")}</Badge><Badge variant="outline">{result.usage.inputTokens??'—'}{tUi(" input · ")}{result.usage.outputTokens??'—'}{tUi(" output tokens")}</Badge></div><p className="break-all text-xs text-muted-foreground">{result.model}{tUi(" · finish: ")}{result.finishReason||tUi("unknown")}</p>
   {result.inputKey!==inputKey&&<p className="text-sm text-amber-500">{tUi("Inputs changed. This result belongs to the previous test.")}</p>}
   <p className="flex items-center gap-2 text-sm">{result.validation.valid?<CheckCircle2 className="size-4 text-telnyx-green"/>:<AlertTriangle className="size-4 text-amber-500"/>}{result.validation.valid?tUi("Structural checks passed"):tUi("Review required")}</p>
   {result.validation.issues.map(issue=><p key={issue} className="text-sm text-amber-500">{issue}</p>)}<p className="text-xs text-muted-foreground">{result.validation.label}</p>
   <JsonBlock value={result.validation.parsed||result.output||tUi('(No response text)')}/><details><summary className="cursor-pointer text-sm">{tUi("Exact request used by this test")}</summary><JsonBlock value={result.request}/></details>
  </section>}
 </div>;
}
