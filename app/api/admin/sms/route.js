import { withSmsUser,readSmsJson } from '@/lib/sms/api';
import { smsAdminOverview,smsAdminResource,smsAdminAction } from '@/lib/sms/admin.mjs';

export const GET=request=>withSmsUser(request,({pool})=>{
  const params=new URL(request.url).searchParams;
  return params.has('resource')?smsAdminResource(pool,params):smsAdminOverview(pool);
},{admin:true});
export const POST=request=>withSmsUser(request,async({pool,agentId})=>smsAdminAction(pool,await readSmsJson(request),agentId),{admin:true});
