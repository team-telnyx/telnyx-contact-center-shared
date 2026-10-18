"use client";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useEffect,useState } from "react";
import { BookOpen,Brain,Database,RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import AIModels from "@/components/assistants/AIModels";
import { COPILOT_MIN_TOKENS,COPILOT_MAX_TOKENS,DEFAULT_CHAT_COPILOT_SETTINGS } from "@/lib/contact-center/chat-copilot-settings.mjs";

// inheritedModel: the model used when this channel has none of its own
// (AI Copilot "Reply suggestions" card, then the platform default).
export default function ChatCopilotSettings({value,onChange,disabled,channel="chat",showRefresh=true,embedded=false,inheritedModel=""}){
  const tUi = useUiText();
  const [catalog,setCatalog]=useState({models:[],buckets:[]}),[loading,setLoading]=useState(true),[error,setError]=useState(""),[filter,setFilter]=useState(""),[revision,setRevision]=useState(0);
  useEffect(()=>{const controller=new AbortController();
    fetch("/api/admin/system-settings?catalog=copilot",{cache:"no-store",signal:controller.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error);if(controller.signal.aborted)return;setCatalog(data);setError(data.error||"");})
      .catch(e=>{if(e.name!=="AbortError"){setCatalog({models:[],buckets:[]});setError(e.message);}}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});return()=>controller.abort();
  },[revision]);
  useEffect(()=>{
    // The embedding catalog is authoritative. Only update the local draft after
    // a successful load; an outage must not erase the saved knowledge sources.
    if(loading||error)return;
    const bucketIds=value.bucketIds.filter(bucket=>catalog.buckets.includes(bucket));
    if(bucketIds.length!==value.bucketIds.length)onChange({...value,bucketIds});
  },[catalog,loading,error,value,onChange]);
  function toggle(bucket){const exists=value.bucketIds.includes(bucket);if(!exists&&value.bucketIds.length>=5)return;onChange({...value,bucketIds:exists?value.bucketIds.filter(b=>b!==bucket):[...value.bucketIds,bucket]});}
  const models=value.model&&!catalog.models.some(model=>model.id===value.model)?[{id:value.model,name:value.model},...catalog.models]:catalog.models;
  const buckets=[...new Set(catalog.buckets)].filter(bucket=>bucket.toLowerCase().includes(filter.trim().toLowerCase()));
  const maxTokens=value.maxTokens??DEFAULT_CHAT_COPILOT_SETTINGS.maxTokens;
  const invalidTokens=!Number.isInteger(maxTokens)||maxTokens<COPILOT_MIN_TOKENS||maxTokens>COPILOT_MAX_TOKENS;
  const Root=embedded?"div":Card,Body=embedded?"div":CardContent;
  const layout=embedded?"grid gap-4":"grid gap-4 md:grid-cols-[minmax(0,1fr)_14rem]";
  return <Root className={embedded?"min-w-0":"w-full shadow-sm"}>
    {!embedded&&<CardHeader><div className="flex items-start gap-3"><span className="rounded-xl bg-violet-500/10 p-2.5 text-violet-600 dark:text-violet-300"><Brain className="size-5"/></span><div className="flex-1"><CardTitle>{tUi("AI Copilot")}</CardTitle><p className="mt-1 text-sm text-muted-foreground">{tUi("Reply suggestions for agents handling ")}{channel === "email" ? tUi("email") : channel === "sms" ? tUi("SMS") : tUi("chat")}{tUi(" conversations.")}</p></div>{showRefresh&&<Button type="button" variant="ghost" size="icon" aria-label={tUi("Refresh models and buckets")} onClick={()=>{setLoading(true);setError("");setRevision(n=>n+1);}} disabled={loading}><RefreshCw className={`size-4 ${loading?"animate-spin":""}`}/></Button>}</div></CardHeader>}
    <Body className="space-y-5">
      {embedded&&showRefresh&&<Button type="button" variant="outline" size="sm" onClick={()=>{setLoading(true);setError("");setRevision(n=>n+1);}} disabled={disabled||loading}><RefreshCw className={`size-4 ${loading?"animate-spin":""}`}/>{tUi("Refresh models and buckets")}</Button>}
      {loading?<div role="status" aria-label={tUi("Loading Copilot options")} className="space-y-5"><span className="sr-only">{tUi("Loading Copilot options")}</span><div className={layout}>{[0,1].map(i=><div key={i} className="space-y-2"><Skeleton className="h-4 w-24"/><Skeleton className="h-10 w-full"/></div>)}</div><Skeleton className="h-4 w-32"/>{[0,1,2,3].map(i=><Skeleton key={i} className="h-12 w-full"/>)}</div>:<>
      {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className={layout}>
        <div className="min-w-0 space-y-2"><Label htmlFor={`copilot-model-${channel}`}>{tUi("AI model")}</Label><AIModels id={`copilot-model-${channel}`} value={value.model} onValueChange={model=>onChange({...value,model})} models={models} disabled={disabled||loading} triggerClassName="border bg-background" placeholder={inheritedModel?tUi("Inherited · {value0}", { value0: inheritedModel }):tUi("Platform default")} emptyMessage={tUi("No models found.")}/><p className="text-xs text-muted-foreground">{tUi("Generates up to 5 suggested replies using Telnyx Chat Completions. Leave empty to inherit the platform default model.")}</p>{value.model&&!disabled&&<button type="button" className="text-xs text-primary underline-offset-2 hover:underline" onClick={()=>onChange({...value,model:""})}>{tUi("Use platform default")}</button>}</div>
        <div className="space-y-2"><Label htmlFor={`copilot-max-tokens-${channel}`}>{tUi("Max tokens")}</Label><Input id={`copilot-max-tokens-${channel}`} type="number" min={COPILOT_MIN_TOKENS} max={COPILOT_MAX_TOKENS} step={1} required value={maxTokens} onChange={event=>onChange({...value,maxTokens:event.target.value===""?"":Number(event.target.value)})} disabled={disabled||loading} aria-invalid={invalidTokens} aria-describedby={`copilot-token-help-${channel}`}/><p id={`copilot-token-help-${channel}`} className={`text-xs ${invalidTokens?"text-destructive":"text-muted-foreground"}`}>{invalidTokens?tUi("Enter a whole number from 256 to 32,768."):tUi("Includes the reply and model reasoning. Default: 6,000. Range: 256–32,768.")}</p></div>
      </div>
      <div className="space-y-3"><div className="flex items-center justify-between gap-2"><Label className="flex items-center gap-2"><BookOpen className="size-4"/>{tUi("Storage buckets")}</Label><span className="rounded-full bg-violet-500/10 px-2.5 py-1 text-xs font-medium text-violet-700 dark:text-violet-300">{value.bucketIds.length}{tUi(" / 5 buckets")}</span></div>
        <Input aria-label={tUi("Search knowledge buckets")} placeholder={tUi("Search embedded storage buckets…")} value={filter} onChange={e=>setFilter(e.target.value)} disabled={disabled||loading}/>
        <div className="max-h-72 overflow-y-auto rounded-xl border" role="group" aria-label={tUi("Storage buckets")}>
          {buckets.map(bucket=>{const checked=value.bucketIds.includes(bucket);return <label key={bucket} className="flex items-center gap-3 border-b p-3 text-xs last:border-0 hover:bg-muted/40"><Database className="size-4 shrink-0 text-muted-foreground"/><span className="min-w-0 flex-1 break-all">{bucket}</span><Switch checked={checked} aria-label={bucket} disabled={disabled||loading||!checked&&value.bucketIds.length>=5} onCheckedChange={()=>toggle(bucket)}/></label>;})}
          {!buckets.length&&<p className="p-4 text-xs leading-relaxed text-muted-foreground">{loading?tUi("Loading knowledge sources…"):filter.trim()?tUi("No buckets match your search."):tUi("No embedded buckets available. Embed documents in Telnyx Object Storage to make them available for retrieval.")}</p>}
        </div><p className="text-xs leading-relaxed text-muted-foreground">{tUi("The selected buckets are passed to the retrieval tool with every Copilot request. With no buckets selected, Copilot uses the conversation context.")}</p>
      </div>
      </>}
    </Body>
  </Root>;
}
