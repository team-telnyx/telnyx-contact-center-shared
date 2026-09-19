import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { whatsappRequest } from "@/lib/whatsapp/provider.mjs";
import { templateVariableFields,templatePreviewParts } from "@/lib/whatsapp/templates.mjs";
import { withPermission } from "@/lib/authz/guard";

// Approved templates an agent may send on this conversation (used when the
// 24-hour customer service window is closed).
async function GET_handler(_request, context){
  const user=await getAuthenticatedUser();if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  try{
    const {id}=await context.params;
    const thread=(await pool.query(`SELECT n.waba_id FROM acd_work_items w JOIN cc_whatsapp_threads t ON t.conversation_id=w.conversation_id JOIN cc_whatsapp_numbers n ON n.id=t.number_id
      WHERE w.id=$1 AND w.channel='whatsapp' AND EXISTS(SELECT 1 FROM acd_text_assignments a WHERE a.work_item_id=w.id AND a.agent_id=$2 AND a.state='active')`,[id,String(user.id)])).rows[0];
    if(!thread)return NextResponse.json({error:"Conversation not found or not assigned to you"},{status:403});
    const query=new URLSearchParams({"filter[status]":"APPROVED","page[size]":"100"});
    if(thread.waba_id)query.set("filter[waba_id]",thread.waba_id);
    const result=await whatsappRequest(`/whatsapp/message_templates?${query}`);
    const templates=(result.data||[]).filter(t=>String(t.status||"").toUpperCase()==="APPROVED")
      .map(t=>({id:t.id,name:t.name,language:t.language,category:t.category,status:t.status,components:t.components||[],fields:templateVariableFields(t),preview:templatePreviewParts(t)}));
    return NextResponse.json({templates},{headers:{"Cache-Control":"no-store"}});
  }catch(error){return NextResponse.json({error:error.status?error.message:"Templates are unavailable"},{status:error.status||500});}
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/whatsapp/[id]/templates" });
