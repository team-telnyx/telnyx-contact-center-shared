import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { messagingTransferTargets } from "@/lib/acd/text-transfer.mjs";
import { withPermission } from "@/lib/authz/guard";

async function GET_handler(_request, context, authz){
  const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  try{return NextResponse.json(await messagingTransferTargets(pool,{workItemId:(await context.params).id,agentId:String(authz.user.id),channel:"video"}),{headers:{"Cache-Control":"private, no-store"}});}
  catch(error){return NextResponse.json({error:error.status?error.message:"Transfer options unavailable"},{status:error.status||500});}
}

export const GET = withPermission("agent:self", GET_handler, { route: "/api/contact-center/video/[id]/transfer" });
