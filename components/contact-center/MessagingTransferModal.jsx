"use client";

import { useCallback,useEffect,useRef,useState } from "react";
import { ArrowRightLeft,Loader2,Mail,UserCheck,UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { notify } from "@/components/ToastNotify";
import { channelDefinition } from "@/lib/acd/channel-registry.mjs";

export default function MessagingTransferModal({interaction,onClose,onTransferred}){
  const [data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const [kind,setKind]=useState("queue"),[queueId,setQueueId]=useState(""),[agentKey,setAgentKey]=useState(""),[address,setAddress]=useState("");
  const [busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
  const pending=useRef(null),inFlight=useRef(false),request=useRef(null),alive=useRef(true);
  const channel=interaction.channel,endpoint=`/api/contact-center/${channel}/${interaction.id}`;
  const load=useCallback(async()=>{
    request.current?.abort();const controller=new AbortController();request.current=controller;
    setLoading(true);setError("");
    try{
      const response=await fetch(`${endpoint}/transfer`,{cache:"no-store",signal:controller.signal}),result=await response.json();
      if(!response.ok)throw Error(result.error||"Unable to load transfer destinations");
      if(controller.signal.aborted)return;
      setData(result);setQueueId(current=>result.queues.some(q=>q.id===current)?current:result.currentQueueId||"");
      setAgentKey(current=>result.agents.some(a=>`${a.queue_id}:${a.id}`===current)?current:"");
    }catch(reason){if(!controller.signal.aborted)setError(reason.message);}
    finally{if(!controller.signal.aborted)setLoading(false);}
  },[endpoint]);
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;request.current?.abort();};},[load]);
  const agent=data?.agents.find(a=>`${a.queue_id}:${a.id}`===agentKey);
  const manual=kind==="manual",locked=busy||uncertain;
  const valid=manual?Boolean(data?.forward&&address.trim()):kind==="agent"?Boolean(agent):Boolean(data?.queues.some(q=>q.id===queueId));
  async function submit(event){
    event.preventDefault();if(inFlight.current||!data||(!valid&&!pending.current))return;
    inFlight.current=true;setBusy(true);setError("");
    if(!pending.current)pending.current={commandId:crypto.randomUUID(),expectedVersion:data.version,
      ...(manual?{action:"forward",messageId:data.forward.message_id,to:address.trim()}:{action:"transfer",queueId:kind==="agent"?agent.queue_id:queueId,targetAgentId:kind==="agent"?agent.id:null})};
    try{
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pending.current)}),result=await response.json();
      if(!response.ok){
        if(response.status<500){pending.current=null;if(alive.current){setUncertain(false);void load();}}
        throw Error(result.error||"Unable to transfer interaction");
      }
      pending.current=null;
      notify({title:manual?"Email forwarding requested":"Interaction transferred",description:manual?"The email and its attachments have been queued for delivery. This conversation remains assigned to you.":undefined,variant:"success"});
      onTransferred?.();if(alive.current)onClose();
    }catch(reason){if(alive.current){setUncertain(Boolean(pending.current));setError(reason.message);}}
    finally{inFlight.current=false;if(alive.current)setBusy(false);}
  }
  const destinations=[{id:"queue",label:"Queues",icon:UsersRound,color:"text-blue-600 dark:text-blue-400",selected:"border-blue-500 bg-blue-500/10"},
    {id:"agent",label:"Agents",icon:UserCheck,color:"text-purple-600 dark:text-purple-400",selected:"border-purple-500 bg-purple-500/10"},
    ...(channel==="email"?[{id:"manual",label:"Manual address",icon:Mail,color:"text-orange-600 dark:text-orange-400",selected:"border-orange-500 bg-orange-500/10"}]:[])];
  return <Dialog open onOpenChange={open=>{if(!open&&!locked)onClose();}}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-[700px]" showCloseButton={!locked}>
    <DialogHeader><DialogTitle>Transfer {channel==="chat"?"chat":channel==="email"?"email":channelDefinition(channel).label}</DialogTitle><DialogDescription>Choose a destination for {interaction.from_name||interaction.attributes?.subject||"the selected interaction"}.</DialogDescription></DialogHeader>
    <form onSubmit={submit} className="space-y-5">
      <div role="group" aria-label="Transfer destination type" className={`grid gap-3 ${channel==="email"?"grid-cols-3":"grid-cols-2"}`}>
        {destinations.map(({id,label,icon:Icon,color,selected})=><button key={id} type="button" aria-pressed={kind===id} disabled={locked} onClick={()=>{setKind(id);setError("");}} className={`flex flex-col items-center gap-2 rounded-lg border-2 px-3 py-4 text-xs font-medium transition-colors disabled:opacity-50 ${kind===id?selected:"border-border hover:bg-muted/50"}`}><Icon className={`size-5 ${color}`}/>{label}</button>)}
      </div>
      {loading?<div role="status" aria-label="Loading transfer destinations" className="space-y-3"><Skeleton className="h-4 w-36"/><Skeleton className="h-10 w-full"/><Skeleton className="h-3 w-64 max-w-full"/></div>:!data?<div className="text-sm"><p role="alert" className="text-destructive">{error}</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={()=>void load()}>Retry loading destinations</Button></div>:<div className="space-y-3">
        {manual?<>
          <Label htmlFor="messaging-forward-address">Email address</Label><Input id="messaging-forward-address" type="email" autoComplete="off" placeholder="name@example.com" value={address} onChange={e=>setAddress(e.target.value)} disabled={locked||!data.forward} required/>
          <p className="text-xs leading-relaxed text-muted-foreground">{data.forward?<>Forward the latest customer email, “{data.forward.subject||"(No subject)"}”, with {data.forward.attachment_count} attachment(s). The conversation remains assigned to you, and your reply draft is kept.</>:"There is no received email available to forward, or sending is paused for this mailbox."}</p>
        </>:kind==="agent"?<>
          <Label htmlFor="messaging-transfer-agent">Available agent</Label>
          {data.agents.length?<select id="messaging-transfer-agent" value={agentKey} onChange={e=>setAgentKey(e.target.value)} disabled={locked} required className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">Select an agent</option>{data.agents.map(a=><option key={`${a.queue_id}:${a.id}`} value={`${a.queue_id}:${a.id}`}>{[a.first_name,a.last_name].filter(Boolean).join(" ")||a.id} · {data.queues.find(q=>q.id===a.queue_id)?.name}</option>)}</select>:<p className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">No other agents currently have capacity for {channel}.</p>}
          <p className="text-xs text-muted-foreground">The selected agent receives an offer to accept this interaction.</p>
        </>:<>
          <Label htmlFor="messaging-transfer-queue">Queue</Label>
          {data.queues.length?<select id="messaging-transfer-queue" value={queueId} onChange={e=>setQueueId(e.target.value)} disabled={locked} required className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"><option value="">Select a queue</option>{data.queues.map(q=><option key={q.id} value={q.id}>{q.name}</option>)}</select>:<p className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">No queues are accepting {channel}.</p>}
          <p className="text-xs text-muted-foreground">The interaction will wait in this queue for an available agent.</p>
        </>}
        {error&&<p role="alert" className="text-sm text-destructive">{error}</p>}
      </div>}
      {uncertain&&<p role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs">The result could not be confirmed. Retry to check the same request without creating a duplicate.</p>}
      <DialogFooter><Button type="button" variant="outline" disabled={locked} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy||loading||!data||(!valid&&!uncertain)}>{busy?<Loader2 className="size-4 animate-spin"/>:manual?<Mail className="size-4"/>:<ArrowRightLeft className="size-4"/>}{uncertain?"Confirm previous request":manual?"Forward email":`Transfer ${channel}`}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
