import { withVideoDevice } from "@/lib/acd/media-device-control.mjs";
import { createMobileScreenGrant } from "@/lib/video/mobile-screen.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { agentJoinToken, refreshJoinToken } from "@/lib/video/lifecycle.mjs";
import { withPermission } from "@/lib/authz/guard";

// Short-lived Telnyx join token for the agent's browser. Issued only to the
// agent whose assignment is active; refreshed with the token's own refresh token.
async function POST_handler(request, context, authz){
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  try{
    const {id}=await context.params;const body=await request.json().catch(()=>({}));
    return await withVideoDevice(pool,authz.user,request,id,async()=>{
    if(body.screen===true)return NextResponse.json({ok:true,...await createMobileScreenGrant(pool,{workItemId:id,agentId:String(authz.user.id)})},{headers:{"Cache-Control":"no-store"}});
    const join=body.refreshToken
      ?await refreshJoinToken(pool,{workItemId:id,refreshToken:body.refreshToken,agentId:String(authz.user.id)})
      :await agentJoinToken(pool,{workItemId:id,agentId:String(authz.user.id)});
    return NextResponse.json({ok:true,join},{headers:{"Cache-Control":"no-store"}});
    });
  }catch(error){return NextResponse.json({error:error.status?error.message:"Video token unavailable"},{status:error.status||500});}
}

export const POST = withPermission("agent:self", POST_handler, { route: "/api/contact-center/video/[id]/token" });
