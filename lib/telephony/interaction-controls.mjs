import { usesNativeLifecycle } from "../acd/channel-registry.mjs";
const connectedStates=new Set(["active","connected","answered","held","parked"]);
const endedStates=new Set(["completed","abandoned","hangup","ended","destroy","idle","terminated","failed","wrapup"]);
const incomingStates=new Set(["ringing","offered","new","trying","early","initiated","bridging"]);
const value=input=>input==null?"":String(input);

// A work-item identity wins over leg aliases. Never correlate calls by direction
// or telephone number: unrelated cards can share both.
export function matchesInteractionCall(interaction,state){
  if(!interaction?.id||!state?.call||usesNativeLifecycle(interaction.channel))return false;
  const workId=state.contactCenter?.interactionId;
  if(workId)return value(workId)===value(interaction.id);
  const call=state.call;
  const aliases=new Set([state.callControlId,state.originalCallControlId,state.rtcCallId,state.originalCallSessionId,state.callSessionId,
    call.id,call.callId,call.callControlId,call.call_control_id,call.callSessionId,call.call_session_id].filter(Boolean).map(value));
  return [interaction.id,interaction.call_control_id,interaction.callControlId,interaction.original_call_control_id,interaction.rtc_call_id,
    interaction.call_session_id,interaction.callSessionId,interaction.metadata?.original_call_control_id,interaction.metadata?.agent_call_control_id]
    .filter(Boolean).some(id=>aliases.has(value(id)));
}

export function voiceInteractionPhase(interaction,state){
  const matched=matchesInteractionCall(interaction,state),callState=matched?state:null;
  const status=value(callState?.status||callState?.call?.state||interaction?.state).toLowerCase();
  if(interaction?.completed_at||interaction?.abandoned_at||endedStates.has(status))return "ended";
  if(connectedStates.has(status))return "connected";
  const direction=value(callState?.direction||interaction?.direction).toLowerCase();
  if(["outgoing","outbound"].includes(direction))return "dialing";
  if(callState?.ui?.isRinging||incomingStates.has(status))return "incoming";
  return "connecting";
}

export function voiceInteractionActions(interaction,state){
  const phase=voiceInteractionPhase(interaction,state);
  if(phase==="incoming")return ["answer","reject"];
  if(phase==="connected")return ["transfer","hangup"];
  if(phase==="dialing")return ["cancel"];
  return [];
}

export function createInteractionCallControls(){
  let owner=null,inFlight=null;
  return {
    register(controller){owner=controller;return()=>{if(owner===controller)owner=null;};},
    async request(action,interaction){
      const current=owner;if(!current)throw Error("Phone controls are unavailable. Open the phone panel and try again.");
      const state=current.getState(),handlers=current.getHandlers();
      if(!matchesInteractionCall(interaction,state)||handlers.call!==state.call)throw Error("This call has changed. Refresh the interaction and try again.");
      if(state.consultInProgress)throw Error("Use the phone panel to manage the ongoing consultation.");
      if(!voiceInteractionActions(interaction,state).includes(action))throw Error("This action is no longer available for the call.");
      if(inFlight)throw Error("A phone action is already in progress.");
      const handler=handlers[action==="cancel"?"hangup":action];
      if(typeof handler!=="function")throw Error("This phone action is unavailable.");
      const token={};inFlight=token;
      try{return await handler(interaction);}finally{if(inFlight===token)inFlight=null;}
    },
  };
}

// The mini phone owns SDK mutations, audio attachment and the transfer dialog.
export const interactionCallControls=createInteractionCallControls();
