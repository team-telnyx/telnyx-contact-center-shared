import { messagingDraftScope } from "@/lib/acd/draft-scope.mjs";
import { mobileThread } from "@/lib/acd/mobile-monitor-pages.mjs";
import { withEmailUser,readEmailJson } from '@/lib/email/api';
import { readEmailDetail,saveEmailDraft,sendAgentEmail,cancelScheduledEmail } from '@/lib/email/store.mjs';
import { actOnTextWork } from '@/lib/acd/text-lifecycle.mjs';
import { transferEmailWork } from '@/lib/acd/email-work.mjs';
import { prepareForwardDraft,forwardEmailWork } from '@/lib/email/forward.mjs';

export const GET=(request,context)=>withEmailUser(request,async({pool,agentId,user})=>{
  let knownDraftVersions={};
  try{const value=new URL(request.url).searchParams.get('draftVersions');if(value&&value.length<3000)knownDraftVersions=JSON.parse(value);}catch{}
  return mobileThread(await readEmailDetail(pool,{workItemId:(await context.params).id,agentId,draftScope:messagingDraftScope(user),knownDraftVersions}),new URL(request.url).searchParams);
});
export const POST=(request,context)=>withEmailUser(request,async({pool,agentId,user})=>{
  const workItemId=(await context.params).id,input=await readEmailJson(request),identity={workItemId,agentId,draftScope:messagingDraftScope(user)};
  if(input.action==='prepare_forward')return prepareForwardDraft(pool,{...identity,messageId:input.messageId});
  if(input.action==='draft'||input.action==='discard_draft')return saveEmailDraft(pool,{...identity,content:input.content,expectedVersion:input.expectedDraftVersion,draftId:input.draftId,discard:input.action==='discard_draft'});
  if(input.action==='send')return sendAgentEmail(pool,{...input,...identity});
  if(input.action==='cancel_scheduled')return cancelScheduledEmail(pool,{...identity,messageId:input.messageId});
  if(input.action==='transfer')return transferEmailWork(pool,{...input,...identity});
  if(input.action==='forward')return forwardEmailWork(pool,{...input,...identity});
  return actOnTextWork(pool,{...input,...identity,channel:'email'});
});
