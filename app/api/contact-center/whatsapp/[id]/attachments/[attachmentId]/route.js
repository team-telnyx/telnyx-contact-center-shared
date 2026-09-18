import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { attachmentResponse } from "@/lib/widgets/attachments";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(request, context){
  const user=await getAuthenticatedUser();if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Service unavailable"},{status:503});
  const {id,attachmentId}=await context.params;
  const file=(await pool.query(`SELECT f.* FROM acd_text_attachments f JOIN acd_work_items w ON w.conversation_id=f.conversation_id
    WHERE w.id=$1 AND w.channel='whatsapp' AND f.id=$2 AND (EXISTS(SELECT 1 FROM acd_text_assignments a JOIN acd_segments s ON s.id=a.segment_id
      WHERE a.work_item_id=w.id AND a.agent_id=$3 AND ((a.state IN ('active','wrapup') AND s.outcome IS DISTINCT FROM 'transferred') OR w.terminal_at IS NOT NULL))
      OR EXISTS(SELECT 1 FROM acd_offers o WHERE o.work_item_id=w.id AND o.agent_id=$3 AND o.state IN ('created','ringing')))`,[id,attachmentId,String(user.id)])).rows[0];
  return file?attachmentResponse(request,file):NextResponse.json({error:"Attachment not found"},{status:404});
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/whatsapp/[id]/attachments/[attachmentId]" });
