import { withWhatsAppUser,readWhatsAppJson } from '@/lib/whatsapp/api';
import { whatsappAdminOverview,whatsappAdminResource,whatsappAdminAction } from '@/lib/whatsapp/admin.mjs';

export const GET=request=>withWhatsAppUser(request,({pool})=>{
  const params=new URL(request.url).searchParams;
  return params.has('resource')?whatsappAdminResource(pool,params):whatsappAdminOverview(pool);
},{admin:true});
export const POST=request=>withWhatsAppUser(request,async({pool,agentId})=>whatsappAdminAction(pool,await readWhatsAppJson(request),agentId),{admin:true});
