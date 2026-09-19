import { withEmailUser,readEmailJson } from '@/lib/email/api';
import { emailAdminOverview,emailAdminResource,emailAdminAction } from '@/lib/email/admin.mjs';
export const GET=request=>withEmailUser(request,({pool})=>{
  const params=new URL(request.url).searchParams;
  return params.has('resource')?emailAdminResource(pool,params):emailAdminOverview(pool);
},{admin:true});
export const POST=request=>withEmailUser(request,async({pool,agentId})=>emailAdminAction(pool,await readEmailJson(request),agentId),{admin:true});
