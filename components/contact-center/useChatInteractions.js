"use client";
import { createContext,useCallback,useContext,useEffect,useRef,useState } from "react";
import { NATIVE_LIFECYCLE_CHANNELS } from "@/lib/acd/channel-registry.mjs";

const emptyFeed={interactions:[],utilization:null,notificationSounds:null,error:"",loading:true,refresh:async()=>[],soundBlocked:false,enableSound:()=>{},desktopVisible:false,setDesktopVisible:()=>{},requestedInteractionId:null,requestInteraction:()=>{},clearRequestedInteraction:()=>{}};
export const AgentInteractionsContext=createContext(emptyFeed);

// Consumers never start another feed, heartbeat or sound player.
export function useChatInteractions(){return useContext(AgentInteractionsContext);}

// Mounted once in the portal, independently of the current route or desktop tab.
export function useAgentInteractionFeed(agentId){
  const [state,setState]=useState({...emptyFeed,agentId:null});
  const request=useRef(null),generation=useRef(0),inFlight=useRef(null),refreshAgain=useRef(false);
  const refresh=useCallback(async()=>{
    if(!agentId)return [];
    if(inFlight.current){refreshAgain.current=true;return inFlight.current;}
    const controller=new AbortController(),current=generation.current;request.current=controller;
    const task=(async()=>{
      try {
        do {
          refreshAgain.current=false;
          try {
            const response=await fetch("/api/contact-center/chat",{cache:"no-store",signal:controller.signal});
            const body=await response.json();
            if(!response.ok)throw new Error(body.error||"Interactions unavailable");
            if(controller.signal.aborted||current!==generation.current)return;
            setState(previous=>({agentId,
              interactions:JSON.stringify(previous.interactions)===JSON.stringify(body.interactions)?previous.interactions:body.interactions||[],
              utilization:body.utilization,
              notificationSounds:JSON.stringify(previous.notificationSounds)===JSON.stringify(body.notificationSounds)?previous.notificationSounds:body.notificationSounds,
              error:"",loading:false}));
            if(!refreshAgain.current)return body.interactions;
          } catch(reason) {
            if(controller.signal.aborted||current!==generation.current)return;
            setState(previous=>({...previous,agentId,error:reason.message,loading:false}));
            return [];
          }
        } while(refreshAgain.current&&!controller.signal.aborted&&current===generation.current);
      } finally {if(current===generation.current)inFlight.current=null;}
    })();inFlight.current=task;
    return task;
  },[agentId]);
  useEffect(()=>{
    const sessionGeneration=++generation.current;inFlight.current=null;refreshAgain.current=false;
    if(!agentId)return;
    const sessionId=crypto.randomUUID();
    const heartbeat=(offline=false)=>fetch("/api/contact-center/agent/session",{method:"PUT",keepalive:offline,
      headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId,deviceId:"text-portal",chatReady:true,emailReady:true,ready:Object.fromEntries(NATIVE_LIFECYCLE_CHANNELS.map(channel=>[channel,true])),offline})}).catch(()=>{});
    const leave=()=>void heartbeat(true),resume=()=>{void heartbeat();void refresh();};
    const update=()=>void refresh();
    void heartbeat();update();
    const timer=setInterval(update,3000),presence=setInterval(()=>void heartbeat(),15000);
    window.addEventListener("contact-center:acd-state",update);
    window.addEventListener("contact-center:chat-changed",update);
    window.addEventListener("pagehide",leave);
    window.addEventListener("pageshow",resume);
    window.addEventListener("online",resume);
    return()=>{generation.current=sessionGeneration+1;clearInterval(timer);clearInterval(presence);request.current?.abort();inFlight.current=null;refreshAgain.current=false;void heartbeat(true);
      window.removeEventListener("contact-center:acd-state",update);window.removeEventListener("contact-center:chat-changed",update);window.removeEventListener("pagehide",leave);window.removeEventListener("pageshow",resume);window.removeEventListener("online",resume);};
  },[agentId,refresh]);
  return {...(state.agentId===agentId?state:emptyFeed),refresh};
}
