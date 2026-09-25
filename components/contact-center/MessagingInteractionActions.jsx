"use client";
import { useVideoDeviceControl } from "@/hooks/use-video-device-control";
import { voiceFetch } from "@/lib/telephony/endpoint-client";

import { useEffect,useRef,useState } from "react";
import { ArrowRightLeft,Check,ClipboardCheck,Clock,Monitor,RotateCw,X } from "lucide-react";
import { InteractionActionButton as ActionButton,InteractionActionGroup } from "./InteractionActionGroup";
import { notify } from "@/components/ToastNotify";
import MessagingTransferModal from "./MessagingTransferModal";
import { channelDefinition } from "@/lib/acd/channel-registry.mjs";
import CobrowseAgentModal from "./CobrowseAgentModal";

// Each card owns its commands and dialog, independently of the selected card.
export default function MessagingInteractionActions({interaction,onChanged}){
  const [busy,setBusy]=useState(null),[transferOpen,setTransferOpen]=useState(false),[uncertain,setUncertain]=useState(false),[cobrowseOpen,setCobrowseOpen]=useState(false);
  const {canControl:controlsVideo,reason:deviceReason}=useVideoDeviceControl(interaction);
  const pending=useRef(null),inFlight=useRef(false),alive=useRef(true);
  const channel=interaction.channel,offered=interaction.state==="ringing",wrapup=interaction.state==="wrapup";
  // Chat ends with the visitor session; provider channels complete an episode while the thread stays open.
  const definition=channelDefinition(channel),label=channel==="chat"?"chat":channel==="email"?"email":channel==="video"?"video call":definition.label,completes=Boolean(definition.capabilities?.deliveryEvidence);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  function changed(){
    window.dispatchEvent(new CustomEvent("contact-center:chat-changed"));onChanged?.();
  }
  async function command(action){
    if(inFlight.current||!controlsVideo)return;
    inFlight.current=true;setBusy(action);
    try{
      if(!pending.current)pending.current={action,commandId:crypto.randomUUID(),expectedVersion:interaction.version,offerId:interaction.offer_id};
      const response=await voiceFetch(`/api/contact-center/${channel}/${interaction.id}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(pending.current)});
      const result=await response.json();
      if(!response.ok){if(response.status<500)pending.current=null;throw Error(result.error||"Unable to update interaction");}
      pending.current=null;if(alive.current)setUncertain(false);changed();
    }catch(error){
      if(alive.current){setUncertain(Boolean(pending.current));notify({title:"Interaction action failed",description:pending.current?`${error.message}. Use Confirm previous request to check the result.`:error.message,variant:"error"});}
    }finally{inFlight.current=false;if(alive.current)setBusy(null);}
  }
  const disabled=action=>!controlsVideo||Boolean(busy)||Boolean(pending.current&&pending.current.action!==action);
  return <>
    {!controlsVideo && <span className="text-xs text-muted-foreground">{deviceReason}</span>}
    <InteractionActionGroup label="Messaging interaction controls">
      {uncertain?<ActionButton description={deviceReason} label="Confirm previous request" icon={RotateCw} busy={Boolean(busy)} disabled={!controlsVideo||Boolean(busy)} onClick={()=>void command(pending.current.action)}/>:offered?<>
        <ActionButton description={deviceReason} label={`Accept ${label}`} icon={Check} tone="positive" disabled={disabled("accept")} busy={busy==="accept"} onClick={()=>void command("accept")}/>
        <ActionButton description={deviceReason} label="Decline" icon={X} tone="negative" disabled={disabled("reject")} busy={busy==="reject"} onClick={()=>void command("reject")}/>
      </>:wrapup?<ActionButton description={deviceReason} label="Complete wrap-up in the Wrapup Codes sheet" icon={ClipboardCheck} disabled/>:<>
        {interaction.state === "active" && definition.capabilities?.cobrowse && <ActionButton description={deviceReason} label="Co-browse" icon={Monitor} disabled={!controlsVideo||Boolean(busy)} onClick={()=>setCobrowseOpen(true)}/>}
        <ActionButton description={deviceReason} label={`Transfer ${label}`} icon={ArrowRightLeft} disabled={!controlsVideo||Boolean(busy||pending.current)} onClick={()=>setTransferOpen(true)}/>
        {completes&&<ActionButton description={deviceReason} label="Waiting for customer" icon={Clock} disabled={disabled("wait")} busy={busy==="wait"} onClick={()=>void command("wait")}/>}
        <ActionButton description={deviceReason} label={completes?`Complete ${label}`:`End ${label}`} icon={completes?Check:X} tone={completes?undefined:"negative"} disabled={disabled(completes?"complete":"disconnect")} busy={busy===(completes?"complete":"disconnect")} onClick={()=>void command(completes?"complete":"disconnect")}/>
      </>}
    </InteractionActionGroup>
    {transferOpen&&controlsVideo&&<MessagingTransferModal interaction={interaction} onClose={()=>setTransferOpen(false)} onTransferred={changed}/>}
    {cobrowseOpen&&controlsVideo&&<CobrowseAgentModal interaction={interaction} onClose={()=>setCobrowseOpen(false)}/>}
  </>;
}
