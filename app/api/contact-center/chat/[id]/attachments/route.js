import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { receiveTextAttachment } from "@/lib/widgets/attachments";
import { withPermission } from "@/lib/authz/guard";

async function POST_handler(request, context){
  const user=await getAuthenticatedUser();if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Service unavailable"},{status:503});
  try{
    const {id}=await context.params;
    const owned=await pool.query("SELECT 1 FROM acd_text_assignments WHERE work_item_id=$1 AND agent_id=$2 AND state='active'",[id,String(user.id)]);
    if(!owned.rowCount)return NextResponse.json({error:"Chat is not assigned to you"},{status:403});
    return NextResponse.json(await receiveTextAttachment(pool,{workItemId:id,agentId:String(user.id),request}));
  }catch(error){return NextResponse.json({error:error.status?error.message:"Attachment upload failed"},{status:error.status||500});}
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { route: "/api/contact-center/chat/[id]/attachments" });
