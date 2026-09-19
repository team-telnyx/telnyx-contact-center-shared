import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {AppRouterContext} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {AgentInteractionsProvider} from '../../components/contact-center/AgentInteractionsProvider';
import IncomingInteractionAlert from '../../components/contact-center/IncomingInteractionAlert';
import {useChatInteractions} from '../../components/contact-center/useChatInteractions';
import {NOTIFICATION_SOUNDS} from '../../lib/contact-center/notification-sounds.mjs';
const fixture=window.fixture={interactions:[],sessions:[],plays:[],audio:[],requests:0,fail:false,blocked:false};
window.Audio=class {
  constructor(){fixture.audio.push(this);}
  play(){fixture.plays.push(this.src);return fixture.blocked?Promise.reject(Object.assign(new Error('Gesture needed'),{name:'NotAllowedError'})):Promise.resolve();}
  pause(){this.paused=true;}
};
window.fetch=async(url,options={})=>{
  if(url.endsWith('/agent/session')){fixture.sessions.push({...JSON.parse(options.body),authId:fixture.auth.user.id});return {ok:true,json:async()=>({ok:true})};}
  if(url.endsWith('/chat')){fixture.requests++;return {ok:!fixture.fail,json:async()=>fixture.fail?{error:'Connection lost'}:{interactions:fixture.interactions,notificationSounds:{volume:60,channels:{email:{enabled:true,sound:NOTIFICATION_SOUNDS[0].id,loop:false},chat:{enabled:true,sound:NOTIFICATION_SOUNDS[1].id,loop:false}}}}};}
  throw new Error('Unexpected '+url);
};
fixture.offer=(id,channel='email',duration=60000)=>({id,offer_id:'offer-'+id,channel,state:'ringing',offer_deadline:new Date(Date.now()+duration).toISOString(),from_name:'Demo User',queue_name:channel==='email'?'Sales':'Support'});
fixture.update=items=>{fixture.interactions=items;window.dispatchEvent(new Event('contact-center:acd-state'));};
function Page({route}){
  const {setDesktopVisible,requestedInteractionId,clearRequestedInteraction}=useChatInteractions();
  useEffect(()=>{setDesktopVisible(route==='desktop');return()=>setDesktopVisible(false);},[route,setDesktopVisible]);
  useEffect(()=>{if(route==='desktop'&&requestedInteractionId){fixture.selected=requestedInteractionId;clearRequestedInteraction();}},[route,requestedInteractionId,clearRequestedInteraction]);
  return <main className="p-8"><p className="mb-2 text-xs uppercase tracking-widest text-muted-foreground">Agent workspace</p><h1 className="text-2xl font-semibold">{route==='desktop'?'Agent Desktop':'Contacts'}</h1><p className="mt-8 text-muted-foreground">{route==='desktop'?'Select Accept to receive the interaction.':'Your contact directory'}</p></main>;
}
function App(){
  const [route,setRoute]=useState('contacts'),[agent,setAgent]=useState('agent-1'),[roles,setRoles]=useState(['agent']);fixture.setRoles=setRoles;fixture.auth={isAuth:Boolean(agent),user:{id:agent,roles}};fixture.navigate=setRoute;fixture.setAgent=setAgent;
  return <AppRouterContext.Provider value={{push:()=>setRoute('desktop')}}><AgentInteractionsProvider>
    <div className="min-h-screen bg-background text-foreground"><header className="cc-app-header border-b"><div className="flex h-16 items-center gap-2 px-6"><span className="mr-auto text-sm font-semibold">▣　Docs</span><IncomingInteractionAlert/><button data-testid="agent-status" className="h-10 w-[280px] rounded-lg border px-4 text-left text-sm">◉　Available　⌄</button><button data-testid="campaign-activation" className="h-10 w-[240px] rounded-lg border text-sm">Campaigns (0/3)　⌄</button><button className="h-10 rounded-lg border px-4 text-sm">Queues (5/7)</button><div className="flex h-10 w-[320px] items-center justify-between rounded-lg border px-3 text-sm"><span className="text-emerald-400">◉　♬</span><span>+48600000001</span><span>☎　⌄</span></div></div></header>
    <Page key={route} route={route}/></div>
  </AgentInteractionsProvider></AppRouterContext.Provider>;
}
createRoot(document.getElementById('root')).render(<App/>);
