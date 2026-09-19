import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { actOnTextWork } from "@/lib/acd/text-lifecycle.mjs";
import { transferTextWork } from "@/lib/acd/text-transfer.mjs";
import { endVideoRoom, readVideoDetail } from "@/lib/video/lifecycle.mjs";
import { withPermission } from "@/lib/authz/guard";

// Video calls share the native lifecycle commands with chat (accept, reject,
// disconnect, wrapup, transfer). Ending the call additionally closes the Telnyx
// room session so the visitor's client drops immediately.
async function handle(request,context,authz){
  const user=authz.user;const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  try{
    const {id}=await context.params;const agentId=String(user.id);
    if(request.method==="GET")return NextResponse.json(await readVideoDetail(pool,{workItemId:id,agentId}),{headers:{"Cache-Control":"no-store"}});
    const body=await request.json();
    if(body.action==="transfer")return NextResponse.json(await transferTextWork(pool,{...body,workItemId:id,agentId,channel:"video"}));
    if(["send","draft","typing","wait","complete"].includes(body.action))return NextResponse.json({error:"Unsupported video action"},{status:400});
    const result=await actOnTextWork(pool,{...body,workItemId:id,agentId,channel:"video"});
    if(body.action==="disconnect"&&result?.ok)await endVideoRoom(pool,{workItemId:id,actor:agentId,reason:"agent_ended"}).catch(()=>undefined);
    return NextResponse.json(result);
  }catch(error){return NextResponse.json({error:error.status?error.message:"Video operation failed"},{status:error.status||500});}
}
export const GET = withPermission("agent:self", handle, { route: "/api/contact-center/video/[id]" });
export const POST = withPermission("agent:self", handle, { route: "/api/contact-center/video/[id]" });
