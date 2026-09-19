import { withEmailUser } from '@/lib/email/api';
import { requireEmailWork } from '@/lib/email/store.mjs';
import { searchEmailRecipients } from '@/lib/email/recipient-search.mjs';

export const GET=request=>withEmailUser(request,async({pool,agentId})=>{
  const params=new URL(request.url).searchParams;
  await requireEmailWork(pool,{workItemId:params.get('workItemId'),agentId,active:true});
  return searchEmailRecipients(pool,{query:params.get('q'),page:params.get('page'),pageSize:params.get('pageSize')});
});
