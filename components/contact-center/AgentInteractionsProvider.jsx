"use client";
import { useCallback,useState } from 'react';
import { useAuth } from '@/components/auth-provider';
import { AgentInteractionsContext,useAgentInteractionFeed } from './useChatInteractions';
import { useInteractionSounds } from './useInteractionSounds';


export function AgentInteractionsRuntime({agentId,children}) {
  const feed=useAgentInteractionFeed(agentId);
  const sound=useInteractionSounds(feed.interactions,feed.notificationSounds,Boolean(agentId)&&!feed.error);
  const [desktopVisible,setDesktopVisible]=useState(false),[requested,setRequested]=useState(null);
  const requestedInteractionId=requested?.agentId===agentId?requested.id:null;
  const requestInteraction=useCallback(id=>setRequested({agentId,id:String(id)}),[agentId]);
  const clearRequestedInteraction=useCallback(()=>setRequested(null),[]);
  return <AgentInteractionsContext.Provider value={{...feed,...sound,desktopVisible,setDesktopVisible,requestedInteractionId,requestInteraction,clearRequestedInteraction}}>{children}</AgentInteractionsContext.Provider>;
}
export function AgentInteractionsProvider({children}){
  const {isAuth,user,canScreen}=useAuth();
  // The desktop feed runs for users whose roles grant the Agent Desktop screen (RBAC Phase 3).
  const eligible = isAuth && user?.id && canScreen("agent.desktop");
  const agentId = eligible ? String(user.id) : null;
  return <AgentInteractionsRuntime agentId={agentId}>{children}</AgentInteractionsRuntime>;
}
