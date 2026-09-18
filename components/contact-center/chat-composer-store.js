"use client";

import { useCallback,useState,useSyncExternalStore } from "react";

const EMPTY={files:[],pending:null,sending:false,error:"",lastSent:null};

// Owned by AgentDesktop, so local files and an uncertain send survive switching
// interactions, but are released when a chat disappears or the workspace closes.
export function createChatComposerStore(){
  const drafts=new Map(),listeners=new Set();
  let activeIds=null;
  return {get:id=>drafts.get(id)||EMPTY,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    retain(ids){
      activeIds=new Set(ids);let changed=false;
      for(const id of drafts.keys())if(!activeIds.has(id)){drafts.delete(id);changed=true;}
      if(changed)for(const listener of listeners)listener();
    },
    update(id,patch){
      // A late send response must not recreate a removed conversation's entry.
      if(activeIds&&!activeIds.has(id))return;
      drafts.set(id,{...(drafts.get(id)||EMPTY),...patch});for(const listener of listeners)listener();
    }};
}

export function useChatComposer(id,providedStore){
  const [localStore]=useState(createChatComposerStore),store=providedStore||localStore;
  const snapshot=useSyncExternalStore(store.subscribe,useCallback(()=>store.get(id),[store,id]),()=>EMPTY);
  return [snapshot,store];
}
