"use client";

import { useEffect,useRef,useState } from "react";
import { ArrowDownToLine,ArrowUpRight,BookOpen,Brain,ChevronDown,ChevronUp,Loader2,Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { CopyChatText } from "./ChatMessageBubble";

function Suggestion({suggestion,index,onInsert,disabled}){
  const [expanded,setExpanded]=useState(false);
  return <article className="rounded-xl border border-border/70 bg-background p-3.5 shadow-sm" data-testid="copilot-suggestion">
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{index===0?"Recommended reply":`Alternative ${index}`}</span>
      <span className="rounded-full bg-teal-500/10 px-2 py-1 text-[10px] font-semibold text-teal-700 dark:text-teal-300" title="AI-estimated confidence, not a verified probability of correctness.">{suggestion.confidence===null?"Unrated":`${Math.round(suggestion.confidence*100)}% confidence`}</span>
    </div>
    <p className={`whitespace-pre-wrap break-words text-[13px] leading-relaxed ${expanded?"":"line-clamp-3"}`}>{suggestion.text}</p>
    {expanded&&suggestion.rationale&&<p className="mt-3 border-t pt-2 text-xs leading-relaxed text-muted-foreground">{suggestion.rationale}</p>}
    <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-2">
      <button type="button" className="flex items-center gap-1 rounded-md py-1 text-[11px] text-muted-foreground hover:text-foreground" onClick={()=>setExpanded(v=>!v)} aria-expanded={expanded}>{expanded?<ChevronUp className="size-3.5"/>:<ChevronDown className="size-3.5"/>}{expanded?"Show less":"Full reply"}</button>
      <div className="flex items-center gap-1"><CopyChatText text={suggestion.text} label="Copy suggested reply"/>
        <Button type="button" size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[11px] text-violet-700 hover:bg-violet-500/10 dark:text-violet-300" onClick={()=>onInsert(suggestion.text)} disabled={disabled} aria-label={`Insert suggested reply ${index+1} into message input`}><ArrowDownToLine className="size-3.5"/>Use reply</Button></div>
    </div>
  </article>;
}
export default function ChatCopilotPanel({workItemId,seed,onInsert,canInsert,onGenerated,channel="chat"}){
  const [question,setQuestion]=useState(""),[result,setResult]=useState(null),[settings,setSettings]=useState(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const input=useRef(null),pending=useRef(null),controller=useRef(null),hasSeed=useRef(false);
  const [previousSeed,setPreviousSeed]=useState(null);
  if(seed!==previousSeed){setPreviousSeed(seed);if(seed)setQuestion(seed.text);}
  const endpoint=`/api/contact-center/${channel}/${workItemId}/copilot`;
  useEffect(()=>{
    const request=new AbortController();
    fetch(endpoint,{cache:"no-store",signal:request.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error);if(request.signal.aborted)return;
      setSettings(data.settings);setResult(data.latest);if(!hasSeed.current&&data.latest)setQuestion(data.latest.question);
    }).catch(e=>{if(e.name!=="AbortError")setError(e.message);}).finally(()=>{if(!request.signal.aborted)setLoading(false);});
    return()=>{request.abort();controller.current?.abort();};
  },[endpoint]);
  useEffect(()=>{if(seed){hasSeed.current=true;input.current?.focus();}},[seed]);
  async function generate(){
    if(busy||!question.trim())return;setBusy(true);setError("");
    const captured=question.trim();
    if(pending.current?.question!==captured)pending.current={question:captured,requestId:crypto.randomUUID()};
    const request=new AbortController();controller.current=request;
    try{
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pending.current),signal:request.signal});
      const data=await response.json();if(!response.ok){if(data.requestState==="failed"||(response.status<500&&!String(data.error).includes("still being confirmed")))pending.current=null;throw Error(data.error||"Unable to generate suggestions");}
      if(request.signal.aborted)return;pending.current=null;setResult(data);onGenerated?.();
    }catch(e){if(e.name!=="AbortError")setError(e.message);}finally{if(!request.signal.aborted)setBusy(false);}
  }
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 border-b bg-gradient-to-br from-violet-500/[0.06] via-background to-background p-4">
      <div className="mb-3 flex items-center gap-2.5"><div className="rounded-xl bg-violet-500/10 p-2 text-violet-600 dark:text-violet-300"><Brain className="size-5"/></div><div><h3 className="text-sm font-semibold">AI reply suggestions</h3><p className="text-[11px] text-muted-foreground">Use your conversation and knowledge sources.</p></div></div>
      <form onSubmit={e=>{e.preventDefault();void generate();}} className="rounded-xl border bg-background p-2 shadow-sm">
        <Textarea ref={input} aria-label="Ask AI Copilot" value={question} maxLength={6000} onChange={e=>{hasSeed.current=true;setQuestion(e.target.value);}} placeholder="Ask a question, or tap the brain on a message…"
          className="min-h-20 resize-none border-0 bg-transparent px-2 text-[13px] shadow-none focus-visible:ring-0" onKeyDown={e=>{if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){e.preventDefault();void generate();}}}/>
        <div className="flex items-center justify-between gap-2 px-1 pt-1"><span className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground"><BookOpen className="size-3"/>{loading?<Skeleton className="h-3 w-24"/>:settings?`${settings.bucketIds.length} knowledge sources`:"Knowledge sources unavailable"}</span>
          <Button type="submit" size="sm" className="h-8 gap-1.5 rounded-lg bg-violet-600 text-xs text-white hover:bg-violet-700" disabled={busy||loading||!settings||!question.trim()}>{busy?<Loader2 className="size-3.5 animate-spin"/>:<Sparkles className="size-3.5"/>}{busy?"Thinking…":"Suggest replies"}</Button></div>
      </form>
      {settings&&<p className="mt-2 truncate text-[10px] text-muted-foreground" title={settings.model}>{settings.model.split("/").at(-1)} · Up to 5 suggestions</p>}
    </div>
    <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
      {error&&<p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{error}</p>}
      {busy||loading?<div className="space-y-3" role="status" aria-label={busy?"Generating suggested replies":"Loading AI Copilot"}>{[0,1,2].map(i=><div key={i} className="space-y-3 rounded-xl border p-4"><Skeleton className="h-2 w-1/3 bg-violet-500/15"/><Skeleton className="h-2 w-full"/><Skeleton className="h-2 w-4/5"/><Skeleton className="h-2 w-2/3"/></div>)}</div>
        :result?<><div className="flex items-center justify-between text-[10px] text-muted-foreground"><span>{result.suggestions.length} replies · AI-estimated confidence</span><time>{new Date(result.generatedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</time></div>
          {result.question!==question.trim()&&<p className="rounded-lg bg-muted/50 p-2 text-xs text-muted-foreground">Replies to: {result.question}</p>}
          {result.suggestions.map((s,i)=><Suggestion key={`${result.requestId}-${i}`} suggestion={s} index={i} onInsert={onInsert} disabled={!canInsert}/>)}
          <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">Confidence is the model’s estimate based on available context. Review the reply before sending.</p></>
          :!loading&&!error&&<div className="grid place-items-center px-5 py-12 text-center"><div className="mb-4 rounded-2xl border border-violet-200/60 bg-violet-500/5 p-4 dark:border-violet-800/40"><Sparkles className="size-7 text-violet-400"/></div><h4 className="text-sm font-medium">Your next reply starts here</h4><p className="mt-2 max-w-64 text-xs leading-relaxed text-muted-foreground">Choose a message with <Brain className="inline size-3.5"/> or write your own question. Move any suggestion into your reply with one click.</p><ArrowUpRight className="mt-4 size-4 text-violet-400"/></div>}
    </div>
  </div>;
}
