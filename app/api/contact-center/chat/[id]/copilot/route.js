import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { generateChatCopilot,readChatCopilot } from "@/lib/contact-center/chat-copilot";
import { withPermission } from "@/lib/authz/guard";

async function handle(request,context,authz){
  const user=authz.user;const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  try{
    const {id}=await context.params,identity={workItemId:id,agentId:String(user.id)};
    const body=request.method==="POST"?await request.json():null;
    const result=body?await generateChatCopilot(pool,{...identity,question:body.question,requestId:body.requestId}):await readChatCopilot(pool,identity);
    return NextResponse.json(result,{headers:{"Cache-Control":"no-store"}});
  }catch(error){return NextResponse.json({error:error.status?error.message:"AI Copilot is unavailable",...(error.requestState==="failed"?{requestState:"failed"}:{})},{status:error.status||500,headers:{"Cache-Control":"no-store"}});}
}
export const GET = withPermission("agent:self", handle, { route: "/api/contact-center/chat/[id]/copilot" });
export const POST = withPermission("agent:self", handle, { route: "/api/contact-center/chat/[id]/copilot" });
