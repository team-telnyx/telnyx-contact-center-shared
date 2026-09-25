import { messagingDraftScope } from "@/lib/acd/draft-scope.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { receiveAgentWhatsAppMessage } from "@/lib/whatsapp/store.mjs";
import { withPermission } from "@/lib/authz/guard";

// Multipart agent send: text plus up to five media files (image, video, audio,
// document, sticker). Each file becomes its own WhatsApp message.
async function POST_handler(request, context, authz){
  const user=authz.user;
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Service unavailable"},{status:503});
  try{return NextResponse.json(await receiveAgentWhatsAppMessage(pool,{workItemId:(await context.params).id,agentId:String(user.id),draftScope:messagingDraftScope(user),request}));}
  catch(error){return NextResponse.json({error:error.status?error.message:"Message upload failed"},{status:error.status||500});}
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const POST = withPermission("agent:self", POST_handler, { route: "/api/contact-center/whatsapp/[id]/messages" });
