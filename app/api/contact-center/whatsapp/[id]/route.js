import { messagingDraftScope } from "@/lib/acd/draft-scope.mjs";
import { mobileThread } from "@/lib/acd/mobile-monitor-pages.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readTextDetail,saveTextDraft } from "@/lib/acd/text-desktop.mjs";
import { actOnTextWork } from "@/lib/acd/text-lifecycle.mjs";
import { transferTextWork } from "@/lib/acd/text-transfer.mjs";
import { whatsappSendOptions,prepareWhatsAppTemplateSend } from "@/lib/whatsapp/store.mjs";
import { whatsappRequest,whatsappId } from "@/lib/whatsapp/provider.mjs";
import { withPermission } from "@/lib/authz/guard";

// Same command surface as chat; sends journal a durable `whatsapp_send` saga.
// Template sends resolve the approved template outside the command transaction.
async function handle(request,context,authz){
  const user=authz.user;const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  try{
    const {id}=await context.params;const agentId=String(user.id);const draftScope=messagingDraftScope(user);
    if(request.method==="GET")return NextResponse.json(mobileThread(await readTextDetail(pool,{workItemId:id,agentId,draftScope,channel:"whatsapp"}),new URL(request.url).searchParams),{headers:{"Cache-Control":"no-store"}});
    const body=await request.json();
    if(body.action==="transfer")return NextResponse.json(await transferTextWork(pool,{...body,workItemId:id,agentId,draftScope,channel:"whatsapp"}));
    if(body.action==="draft")return NextResponse.json(await saveTextDraft(pool,{workItemId:id,agentId,draftScope,body:body.body,expectedVersion:body.expectedDraftVersion}));
    if(body.action==="typing")return NextResponse.json({ok:true});
    if(body.action==="send"&&body.template){
      await readTextDetail(pool,{workItemId:id,agentId,draftScope,channel:"whatsapp"});
      const template=(await whatsappRequest(`/whatsapp/message_templates/${whatsappId(String(body.template.id||""))}`)).data;
      const resolved=prepareWhatsAppTemplateSend(template,body.template.values||{});
      return NextResponse.json(await actOnTextWork(pool,{action:"send",commandId:body.commandId,expectedVersion:body.expectedVersion,draftVersion:body.draftVersion,body:resolved.text,template:resolved,workItemId:id,agentId,draftScope,channel:"whatsapp"},whatsappSendOptions()));
    }
    return NextResponse.json(await actOnTextWork(pool,{...body,workItemId:id,agentId,draftScope,channel:"whatsapp"},whatsappSendOptions()));
  }catch(error){return NextResponse.json({error:error.status?error.message:"WhatsApp operation failed"},{status:error.status||500});}
}
export const GET = withPermission("agent:self", handle, { route: "/api/contact-center/whatsapp/[id]" });
export const POST = withPermission("agent:self", handle, { route: "/api/contact-center/whatsapp/[id]" });
