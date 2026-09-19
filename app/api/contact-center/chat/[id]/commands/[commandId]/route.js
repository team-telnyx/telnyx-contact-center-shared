import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readAgentChatCommand } from "@/lib/contact-center/chat-message-upload";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(_request, context){
  const user=await getAuthenticatedUser();if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Service unavailable"},{status:503});
  try{const {id,commandId}=await context.params;return NextResponse.json(await readAgentChatCommand(pool,{workItemId:id,agentId:String(user.id),commandId}),{headers:{"Cache-Control":"no-store"}});}
  catch(error){return NextResponse.json({error:error.status?error.message:"Unable to confirm message"},{status:error.status||500});}
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/chat/[id]/commands/[commandId]" });
