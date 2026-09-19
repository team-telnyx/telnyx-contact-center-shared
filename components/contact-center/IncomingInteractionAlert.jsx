"use client";
import { useEffect,useState } from 'react';
import { useRouter } from 'next/navigation';
import { Mail,MessageCircle,MessageSquare,MessagesSquare,MonitorUp,Video,Volume2,VolumeX } from 'lucide-react';
import { IconBrandWhatsapp } from '@tabler/icons-react';
import { useChatInteractions } from './useChatInteractions';
import { pendingInteractionOffers,interactionChannelName } from '@/lib/contact-center/interaction-alerts.mjs';

// The presentation is independent of the persistent audio/presence owner.
export function IncomingInteractionNotice({offers,soundBlocked,onEnableSound,onOpen,desktopVisible=false}) {
  if(!offers.length)return null;
  if(desktopVisible)return soundBlocked?<button type="button" onClick={onEnableSound} title="Enable interaction notification sounds" aria-label="Enable interaction notification sounds" className="grid size-9 shrink-0 place-items-center rounded-lg border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300"><VolumeX className="size-4"/></button>:null;
  const first=offers[0],channel=interactionChannelName(first.channel),Icon=({email:Mail,chat:MessageCircle,sms:MessageSquare,whatsapp:IconBrandWhatsapp,video:Video})[first.channel]||MessagesSquare;
  const title=offers.length===1?`New ${channel}`:`${offers.length} new interactions`;
  const description=[first.from_name||first.customer_name||first.customer_address,first.queue_name].filter(Boolean).join(' · ')||'Waiting for you';
  const channelCounts=[...new Set(offers.map(item=>item.channel))].map(channel=>`${offers.filter(item=>item.channel===channel).length} ${interactionChannelName(channel)}`).join(' · ');
  return <div data-testid="incoming-interaction-alert" data-channel={first.channel} className="cc-header-interaction relative flex h-10 shrink-0 items-center gap-2 rounded-xl border px-2" title={`${title} — ${offers.length>1?channelCounts+' · ':''}${description}`}>
    <span className="cc-header-interaction-icon relative grid size-7 shrink-0 place-items-center rounded-lg"><Icon className="size-4"/><span className="cc-header-interaction-dot absolute -right-0.5 -top-0.5 size-2 rounded-full border-2 border-background"/></span>
    <div className="cc-header-interaction-copy min-w-0"><p className="truncate text-[11px] font-semibold leading-4">{title}</p><p className="cc-header-interaction-description max-w-44 truncate text-[10px] leading-3 opacity-75">{offers.length>1?channelCounts:description}</p></div>
    {offers.length>1&&<span className="cc-header-interaction-count grid min-w-5 place-items-center rounded-md px-1 text-[10px] font-bold">{offers.length}</span>}
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{title}. {channelCounts}. Open Agent Desktop to accept.</span>
    {soundBlocked&&<button type="button" onClick={onEnableSound} className="cc-header-interaction-action grid size-7 shrink-0 place-items-center rounded-lg" title="Enable notification sounds" aria-label="Enable interaction notification sounds"><Volume2 className="size-3.5"/></button>}
    <button type="button" onClick={()=>onOpen(first)} aria-label={`Open Agent Desktop for ${channel}${first.queue_name?` in ${first.queue_name}`:''}`} title="Open interaction in Agent Desktop" className="cc-header-interaction-action grid size-7 shrink-0 place-items-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><MonitorUp className="size-4"/></button>
  </div>;
}
export default function IncomingInteractionAlert(){
  const feed=useChatInteractions(),router=useRouter(),[now,setNow]=useState(Date.now);
  useEffect(()=>{
    const initial=setTimeout(()=>setNow(Date.now()),0);
    const timer=feed.interactions.length?setInterval(()=>setNow(Date.now()),500):null;
    return()=>{clearTimeout(initial);clearInterval(timer);};
  },[feed.interactions]);
  const offers=feed.error?[]:pendingInteractionOffers(feed.interactions,now);
  return <IncomingInteractionNotice offers={offers} soundBlocked={feed.soundBlocked} onEnableSound={feed.enableSound} desktopVisible={feed.desktopVisible} onOpen={item=>{
    feed.requestInteraction(item.id);
    router.push('/agent/desktop');
  }}/>;
}
