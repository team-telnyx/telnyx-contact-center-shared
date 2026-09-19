import { withEmailUser,readEmailJson } from '@/lib/email/api';
import { requireEmailWork } from '@/lib/email/store.mjs';
import { emailRequest,emailId } from '@/lib/email/provider.mjs';
export const GET=(request,context)=>withEmailUser(request,async({pool,agentId})=>{
  await requireEmailWork(pool,{workItemId:(await context.params).id,agentId});
  const params=new URL(request.url).searchParams,id=params.get('id');
  return emailRequest(id?`/email_templates/${emailId(id)}`:'/email_templates?page_size=100');
});
export const POST=(request,context)=>withEmailUser(request,async({pool,agentId})=>{
  await requireEmailWork(pool,{workItemId:(await context.params).id,agentId,active:true});
  const input=await readEmailJson(request);
  return emailRequest(`/email_templates/${emailId(input.id)}/render`,{method:'POST',body:{template_variables:input.variables||{}}});
});
