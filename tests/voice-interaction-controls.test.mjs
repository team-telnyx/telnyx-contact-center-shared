import test from "node:test";
import assert from "node:assert/strict";
import { createInteractionCallControls,matchesInteractionCall,voiceInteractionActions } from "../lib/telephony/interaction-controls.mjs";

const card={id:"work-1",channel:"voice",direction:"inbound",state:"ringing",call_control_id:"customer-leg"};
const snapshot=(patch={})=>({call:{id:"agent-leg",state:"ringing"},contactCenter:{interactionId:card.id},status:"ringing",direction:"inbound",ui:{isRinging:true},...patch});

test("routed voice matches its work item even when the browser and customer legs differ",()=>{
  const state=snapshot();assert.equal(matchesInteractionCall(card,state),true);
  assert.equal(matchesInteractionCall({...card,id:"other",call_control_id:"agent-leg"},state),false);
  assert.equal(matchesInteractionCall({...card,channel:"chat"},state),false);
  assert.equal(matchesInteractionCall({...card,channel:"email"},state),false);
});

test("fallback correlation requires an exact known leg instead of a direction or phone number",()=>{
  const state=snapshot({contactCenter:{},direction:"outbound",originalCallControlId:"customer-leg"});
  assert.equal(matchesInteractionCall(card,state),true);
  assert.equal(matchesInteractionCall({...card,id:"unrelated",call_control_id:"other-leg",direction:"outbound"},state),false);
  assert.equal(matchesInteractionCall(card,{...state,call:null}),false);
});

test("minimal controls follow inbound, outbound, connected, held and terminal states",()=>{
  assert.deepEqual(voiceInteractionActions(card,snapshot()),["answer","reject"]);
  assert.deepEqual(voiceInteractionActions(card,snapshot({direction:"outbound"})),["cancel"]);
  for(const status of ["active","answered","connected","held"])
    assert.deepEqual(voiceInteractionActions(card,snapshot({status})),["transfer","hangup"]);
  for(const status of ["completed","hangup","ended","idle","wrapup"])
    assert.deepEqual(voiceInteractionActions(card,snapshot({status})),[]);
  assert.deepEqual(voiceInteractionActions({...card,completed_at:"2026-09-13"},snapshot()),[]);
});

test("session and agent-leg aliases enable card actions before work-item metadata arrives",async()=>{
  for(const [target,patch] of [
    [{...card,call_session_id:"customer-session"},{originalCallSessionId:"customer-session"}],
    [{...card,call_session_id:"sdk-session"},{callSessionId:"sdk-session"}],
    [{...card,metadata:{agent_call_control_id:"agent-leg"}},{}],
  ]){
    const state=snapshot({...patch,contactCenter:{}}),controls=createInteractionCallControls();let answered=0;
    controls.register({getState:()=>state,getHandlers:()=>({call:state.call,answer:()=>answered++})});
    await controls.request("answer",target);assert.equal(answered,1);
    assert.equal(matchesInteractionCall({...target,call_session_id:"unrelated",callSessionId:"unrelated",metadata:{agent_call_control_id:"unrelated"}},state),false);
    state.contactCenter.interactionId="another-work-item";
    await assert.rejects(controls.request("answer",target),/changed/);
  }
});

test("card requests delegate to the phone handlers and preserve the explicit transfer target",async()=>{
  const controls=createInteractionCallControls(),state=snapshot(),calls=[];
  controls.register({getState:()=>state,getHandlers:()=>({call:state.call,answer:()=>calls.push("answer"),reject:()=>calls.push("reject"),hangup:()=>calls.push("hangup"),transfer:target=>calls.push(target)})});
  await controls.request("answer",card);await controls.request("reject",card);
  state.direction="outbound";await controls.request("cancel",card);
  state.status="active";await controls.request("transfer",card);await controls.request("hangup",card);
  assert.deepEqual(calls,["answer","reject","hangup",card,"hangup"]);
});

test("stale cards, stale render handlers, unavailable phases and consultations cannot act on another call",async()=>{
  const controls=createInteractionCallControls(),state=snapshot(),handlers={call:state.call,answer:()=>assert.fail("must not answer")};
  const unregister=controls.register({getState:()=>state,getHandlers:()=>handlers});
  await assert.rejects(controls.request("answer",{...card,id:"another"}),/changed/);
  state.call={id:"replacement"};await assert.rejects(controls.request("answer",card),/changed/);
  handlers.call=state.call;state.status="active";await assert.rejects(controls.request("answer",card),/no longer available/);
  state.consultInProgress=true;await assert.rejects(controls.request("hangup",card),/consultation/);
  unregister();await assert.rejects(controls.request("answer",card),/unavailable/);
});

test("an in-flight action excludes a second command and registration cleanup cannot remove a newer owner",async()=>{
  const controls=createInteractionCallControls(),state=snapshot();let finish,count=0;
  const owner={getState:()=>state,getHandlers:()=>({call:state.call,answer:()=>{count++;return new Promise(resolve=>{finish=resolve;});}})};
  const removeOld=controls.register({...owner});controls.register(owner);removeOld();
  const first=controls.request("answer",card);
  await assert.rejects(controls.request("answer",card),/in progress/);assert.equal(count,1);
  finish();await first;
});
