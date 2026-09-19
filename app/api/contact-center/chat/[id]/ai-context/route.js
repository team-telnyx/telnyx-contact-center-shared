import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readChatAiContext } from "@/lib/contact-center/chat-ai-context";
import { withPermission } from "@/lib/authz/guard";
async function GET_handler(_request, context){
  const user=await getAuthenticatedUser();if(!user)return NextResponse.json({error:"Unauthorized"},{status:401});
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  try{const {id}=await context.params;return NextResponse.json(await readChatAiContext(pool,{workItemId:id,agentId:String(user.id)}),{headers:{"Cache-Control":"no-store"}});}
  catch(error){return NextResponse.json({error:error.status?error.message:"AI context is unavailable"},{status:error.status||500});}
}

// Phase 2 migration: every export goes through the permission guard (the internal documentation).
export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/chat/[id]/ai-context" });
