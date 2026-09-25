"use client";

import { useEffect,useRef,useState } from "react";
import { ArrowRightLeft,Monitor,Phone,PhoneOff,PhoneForwarded } from "lucide-react";
import { notify } from "@/components/ToastNotify";
import { InteractionActionButton,InteractionActionGroup } from "./InteractionActionGroup";
import { interactionCallControls,matchesInteractionCall,voiceInteractionActions,voiceInteractionPhase } from "@/lib/telephony/interaction-controls.mjs";
import {useDeviceHandoff} from "@/hooks/use-device-handoff";
import CobrowseAgentModal from "./CobrowseAgentModal";

const actions={answer:{label:"Answer",icon:Phone,tone:"positive"},reject:{label:"Reject",icon:PhoneOff,tone:"negative"},
  transfer:{label:"Transfer call",icon:ArrowRightLeft},hangup:{label:"Hang up",icon:PhoneOff,tone:"negative"},cancel:{label:"Cancel call",icon:PhoneOff,tone:"negative"}};

export default function VoiceInteractionActions({interaction,callState}){
  const [pending,setPending]=useState(null),inFlight=useRef(false);
  const [cobrowseOpen,setCobrowseOpen]=useState(false);
  const matched=matchesInteractionCall(interaction,callState),phase=voiceInteractionPhase(interaction,callState);
  const busy=pending?.call===callState?.call&&pending?.phase===phase?pending.action:null;
  // A missing SDK status event must leave a way to retry from the card.
  useEffect(()=>{if(!pending)return;const timer=setTimeout(()=>setPending(null),10000);return()=>clearTimeout(timer);},[pending]);
  async function run(action){
    if(inFlight.current||busy)return;
    inFlight.current=true;setPending({action,call:callState.call,phase});
    try{await interactionCallControls.request(action,interaction);if(action==="transfer")setPending(null);}
    catch(error){setPending(null);notify({title:"Call action failed",description:error.message,variant:"error"});}
    finally{inFlight.current=false;}
  }
  const available=voiceInteractionActions(interaction,callState);

  const unavailable=callState?.consultInProgress&&matched?"Use the phone panel to manage the ongoing consultation.":!matched?"Waiting for this call to connect to the phone.":undefined;
  return <><InteractionActionGroup label="Voice interaction controls">
    <VoiceTakeoverAction interaction={interaction}/>
    {available.map(action=><InteractionActionButton key={action} {...actions[action]}
    description={unavailable} disabled={Boolean(busy||unavailable)} busy={busy===action} onClick={()=>void run(action)}/>)}
    {interaction.state === "active" && <InteractionActionButton label="Co-browse" icon={Monitor} disabled={Boolean(unavailable)} onClick={()=>setCobrowseOpen(true)}/>}
  </InteractionActionGroup>{cobrowseOpen&&<CobrowseAgentModal interaction={interaction} onClose={()=>setCobrowseOpen(false)}/>}</>;
}

function VoiceTakeoverAction({interaction}) {
  const active = ["active","connected","answered","held","parked"].includes(interaction.state)
    && !interaction.completed_at && !interaction.abandoned_at;
  const {state,busy,error,pending,command}=useDeviceHandoff(active ? interaction.id : null);
  const progress=["running","compensating"].includes(state?.handoff?.state);
  const remote=state?.active && state.ownerId!==state.currentEndpointId;
  if(!active || (!remote && !progress && !pending))return null;
  const canRetry=Boolean(pending);
  return <InteractionActionButton label={canRetry?"Retry taking over call":"Take over call here"}
    icon={PhoneForwarded} tone="positive" busy={busy||progress}
    disabled={busy||progress||(!canRetry&&!state?.canTakeOver)}
    description={error || (progress?"Taking over the call. Answer on this computer when it rings.":state?.unavailableReason || "Move this call to this computer. The iPhone stays connected until you answer.")}
    onClick={()=>void command(pending || {action:"take_over",expectedOwnerId:state.ownerId,expectedVersion:state.ownerVersion,commandId:crypto.randomUUID()})}/>;
}
