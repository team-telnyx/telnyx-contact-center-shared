"use client";

import { useEffect,useRef,useState } from "react";
import { ArrowRightLeft,Phone,PhoneOff } from "lucide-react";
import { notify } from "@/components/ToastNotify";
import { InteractionActionButton,InteractionActionGroup } from "./InteractionActionGroup";
import { interactionCallControls,matchesInteractionCall,voiceInteractionActions,voiceInteractionPhase } from "@/lib/telephony/interaction-controls.mjs";

const actions={answer:{label:"Answer",icon:Phone,tone:"positive"},reject:{label:"Reject",icon:PhoneOff,tone:"negative"},
  transfer:{label:"Transfer call",icon:ArrowRightLeft},hangup:{label:"Hang up",icon:PhoneOff,tone:"negative"},cancel:{label:"Cancel call",icon:PhoneOff,tone:"negative"}};

export default function VoiceInteractionActions({interaction,callState}){
  const [pending,setPending]=useState(null),inFlight=useRef(false);
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
  if(!available.length)return null;
  const unavailable=callState?.consultInProgress&&matched?"Use the phone panel to manage the ongoing consultation.":!matched?"Waiting for this call to connect to the phone.":undefined;
  return <InteractionActionGroup label="Voice interaction controls">{available.map(action=><InteractionActionButton key={action} {...actions[action]}
    description={unavailable} disabled={Boolean(busy||unavailable)} busy={busy===action} onClick={()=>void run(action)}/>)}</InteractionActionGroup>;
}
