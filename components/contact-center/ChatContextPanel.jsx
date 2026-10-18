"use client";
import { sourceText } from "@/lib/i18n/source-text.mjs";
import { useUiText } from "@/components/i18n/use-ui-text";


import { useEffect,useState } from "react";
import { BarChart3,Brain,Braces,Coins,RefreshCw,SlidersHorizontal } from "lucide-react";
import { Tabs,TabsList,TabsTrigger,TabsContent } from "@/components/ui/tabs";
import ChatCopilotPanel from "./ChatCopilotPanel";
import { CopyChatText } from "./ChatMessageBubble";

const money=(amount,currency="USD",tUi=sourceText)=>amount==null?tUi("Not available"):new Intl.NumberFormat(tUi.locale||"en-US",{style:"currency",currency,minimumFractionDigits:4,maximumFractionDigits:6}).format(amount);
function Fields({values}){
  const tUi = useUiText();return <dl className="divide-y divide-border/60 overflow-hidden rounded-xl border bg-background">{Object.entries(values||{}).map(([key,value])=><div key={key} className="space-y-1.5 p-3"><dt className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{key.replace(/([a-z])([A-Z])/g,"$1 $2").replace(/[._]/g," ")}</dt><dd className="flex items-start gap-2"><span className="min-w-0 flex-1 break-words text-xs">{value===null?"—":String(value)}</span>{value!=null&&<CopyChatText text={String(value)} label={tUi("Copy {value0}", { value0: key })}/>}</dd></div>)}</dl>;}
export default function ChatContextPanel({workItemId,seed,onInsert,canInsert,handoff,channel="chat"}){
  const tUi = useUiText();
  const [tab,setTab]=useState("copilot"),[data,setData]=useState(null),[error,setError]=useState(""),[loading,setLoading]=useState(false),[revision,setRevision]=useState(0);
  const [previousSeed,setPreviousSeed]=useState(null);
  if(seed!==previousSeed){setPreviousSeed(seed);if(seed)setTab("copilot");}
  function selectTab(value){setTab(value);if(value!=="copilot"){setLoading(true);setError("");}}
  function refresh(){setLoading(true);setError("");setRevision(n=>n+1);}
  useEffect(()=>{
    if(tab==="copilot")return;
    const controller=new AbortController();
    fetch(`/api/contact-center/chat/${workItemId}/ai-context`,{cache:"no-store",signal:controller.signal}).then(async response=>{const body=await response.json();if(!response.ok)throw Error(body.error);if(!controller.signal.aborted)setData(body);})
      .catch(e=>{if(e.name!=="AbortError")setError(e.message);}).finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>controller.abort();
  },[workItemId,tab,revision]);
  const summary=data?.handoff||handoff;
  // Provider text channels have no widget insights, variables or AI-handoff costs.
  if(channel!=="chat")return <div className="flex h-full min-h-0 flex-col" data-testid="messaging-context-panel"><ChatCopilotPanel workItemId={workItemId} seed={seed} onInsert={onInsert} canInsert={canInsert} channel={channel}/></div>;
  const generations=data?.costs?.copilot||[];
  const known=generations.filter(g=>g.usage?.estimatedCostUsd!=null),copilotTotal=known.reduce((sum,g)=>sum+g.usage.estimatedCostUsd,0);
  return <Tabs value={tab} onValueChange={selectTab} className="flex h-full min-h-0 flex-col gap-0">
    <div className="shrink-0 px-2 pt-1"><TabsList className="grid grid-cols-5 gap-1">
      {[["copilot","AI Copilot",Brain],["insights","Insights",BarChart3],["metadata","Metadata",Braces],["variables","Variables",SlidersHorizontal],["costs","Costs",Coins]].map(([id,label,Icon])=><TabsTrigger key={id} value={id} className="min-w-0 flex-col gap-1 px-1 pb-2 pt-2 text-[10px]"><Icon className="size-3.5"/>{tUi(label)}</TabsTrigger>)}
    </TabsList></div>
    <TabsContent forceMount value="copilot" className="m-0 flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden"><ChatCopilotPanel workItemId={workItemId} seed={seed} onInsert={onInsert} canInsert={canInsert} onGenerated={()=>setRevision(n=>n+1)}/></TabsContent>
    {tab!=="copilot"&&<TabsContent value={tab} className="m-0 flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center justify-between px-4 pt-4"><h3 className="text-sm font-semibold">{tab==="insights"?tUi("AI handoff insights"):tab==="metadata"?tUi("Interaction metadata"):tab==="variables"?tUi("Dynamic variables"):tUi("Conversation costs")}</h3><button type="button" className="rounded-lg p-2 text-muted-foreground hover:bg-muted" onClick={refresh} aria-label={tUi("Refresh AI context")} disabled={loading}><RefreshCw className={`size-3.5 ${loading?"animate-spin":""}`}/></button></div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 pt-2">
        {error&&<p role="alert" className="rounded-lg bg-destructive/10 p-3 text-xs text-destructive">{error}</p>}
        {loading&&!data&&<p className="text-xs text-muted-foreground" role="status">{tUi("Loading conversation details…")}</p>}
        {tab==="insights"&&<>
          {summary?<><div className="flex flex-wrap gap-2">{[summary.intent,summary.sentiment].filter(Boolean).map((v,i)=><span key={i} className="rounded-full border bg-violet-500/5 px-2.5 py-1 text-[10px] font-medium">{v}</span>)}</div>
            <div className="space-y-2 rounded-xl border bg-violet-500/[0.04] p-4"><p className="text-[10px] font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">{tUi("Summary for the agent")}</p><p className="whitespace-pre-wrap break-words text-[13px] leading-relaxed">{summary.summary}</p><p className="border-t pt-2 text-xs leading-relaxed text-muted-foreground">{summary.reason}</p></div></>:<p className="text-xs text-muted-foreground">{tUi("This conversation started directly with the contact center.")}</p>}
          {data?.insights.map((i,index)=><article key={i.id||index} className="rounded-xl border p-4"><h4 className="mb-2 text-xs font-semibold">{i.name}</h4><p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">{i.result}</p></article>)}
          {data&&!data.insights.length&&<p className="text-xs text-muted-foreground">{data.insightsUnavailable?tUi("Additional provider insights are currently unavailable."):tUi("Additional insights will appear when Telnyx makes them available.")}</p>}
        </>}
        {tab==="metadata"&&<Fields values={data?.metadata}/>}
        {tab==="variables"&&<><p className="text-xs leading-relaxed text-muted-foreground">{tUi("Context passed from the website to the AI assistant.")}</p><Fields values={data?.variables}/></>}
        {tab==="costs"&&<>
          <div className="rounded-xl border bg-muted/20 p-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{tUi("AI assistant · provider billing")}</p><p className="mt-2 text-xl font-semibold tabular-nums">{money(data?.costs?.assistant?.total,data?.costs?.assistant?.currency)}</p><p className="mt-1 text-[11px] text-muted-foreground">{data?.costs?.assistant?.total==null?tUi("Telnyx has not returned a billing record for this chat."):tUi("Reported by Telnyx for this conversation.")}</p></div>
          <div className="rounded-xl border border-violet-200/60 bg-violet-500/[0.04] p-4 dark:border-violet-800/40"><p className="text-[10px] font-semibold uppercase tracking-wider text-violet-700 dark:text-violet-300">{tUi("AI Copilot · estimated inference cost")}</p><p className="mt-2 text-xl font-semibold tabular-nums">{generations.length?money(known.length?copilotTotal:null):tUi("No generations yet")}</p><p className="mt-1 text-[11px] text-muted-foreground">{generations.length}{tUi(" requests · ")}{known.length<generations.length?tUi("Some pricing is unavailable"):tUi("Based on returned token usage and model pricing")}</p></div>
          {generations.map((g,i)=><div key={i} className="space-y-1 rounded-xl border p-3 text-xs"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium" title={g.model}>{g.model?.split("/").at(-1)}</span><span className="shrink-0 tabular-nums">{money(g.usage?.estimatedCostUsd, "USD", tUi)}</span></div><p className="text-[10px] text-muted-foreground">{g.usage?.inputTokens??"—"}{tUi(" input · ")}{g.usage?.outputTokens??"—"}{tUi(" output tokens")}</p></div>)}
        </>}
      </div>
    </TabsContent>}
  </Tabs>;
}
