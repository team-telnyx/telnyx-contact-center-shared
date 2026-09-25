import { messagingDraftScope } from "@/lib/acd/draft-scope.mjs";
import { mobileThread } from "@/lib/acd/mobile-monitor-pages.mjs";
import { NextResponse } from "next/server";
import { getPostgresPool } from "@/lib/postgres.mjs";
import { readTextDetail,saveTextDraft } from "@/lib/acd/text-desktop.mjs";
import { actOnTextWork } from "@/lib/acd/text-lifecycle.mjs";
import { transferTextWork } from "@/lib/acd/text-transfer.mjs";
import { withPermission } from "@/lib/authz/guard";

async function handle(request,context,authz){
  const user=authz.user;const pool=getPostgresPool();if(!pool)return NextResponse.json({error:"Database unavailable"},{status:503});
  try{
    const {id}=await context.params;const agentId=String(user.id);const draftScope=messagingDraftScope(user);
    if(request.method==="GET")return NextResponse.json(mobileThread(await readTextDetail(pool,{workItemId:id,agentId,draftScope}),new URL(request.url).searchParams),{headers:{"Cache-Control":"no-store"}});
    const body=await request.json();
    if(body.action==="transfer")return NextResponse.json(await transferTextWork(pool,{...body,workItemId:id,agentId,draftScope,channel:"chat"}));
    if(body.action==="draft")return NextResponse.json(await saveTextDraft(pool,{workItemId:id,agentId,draftScope,body:body.body,expectedVersion:body.expectedDraftVersion}));
    if(body.action==="typing"){
      const result=await pool.query(`UPDATE acd_text_assignments SET typing_until=CASE WHEN $3 THEN now()+interval '6 seconds' ELSE NULL END
        WHERE work_item_id=$1 AND agent_id=$2 AND state='active' RETURNING work_item_id`,[id,agentId,body.typing===true]);
      return NextResponse.json({ok:result.rowCount>0},{status:result.rowCount?200:403});
    }
    return NextResponse.json(await actOnTextWork(pool,{...body,workItemId:id,agentId,draftScope,channel:"chat"}));
  }catch(error){return NextResponse.json({error:error.status?error.message:"Chat operation failed"},{status:error.status||500});}
}
export const GET = withPermission("agent:self", handle, { route: "/api/contact-center/chat/[id]" });
export const POST = withPermission("agent:self", handle, { route: "/api/contact-center/chat/[id]" });
